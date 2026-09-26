import { connect } from "mqtt";
import type { oauthSessionSchema } from "../oauth/client";
import type { z } from "zod";
import {
  connectionObservation,
  subscriptionObservation,
  pushObservations,
  deviceTopics,
  subscribableDevice,
  type MiotObservation,
} from "./messages";

const CONCURRENCY = 16;
const ACK_TIMEOUT = 10_000;
// MQTT 5 SUBACK: unspecified/internal error, packet ID in use, or quota exceeded.
const RETRYABLE_SUBACK_CODES = new Set([0x80, 0x83, 0x91, 0x97]);
export function isMqttAuthenticationFailure(reason: string | null) {
  return [
    "connack_134",
    "connack_135",
    "connack_138",
    "server_disconnect_135",
  ].includes(reason ?? "");
}

type Listener = (observation: MiotObservation) => void;
function entry(topic: string, rejectedCode: number | undefined) {
  return {
    topic,
    listeners: new Set<Listener>(),
    subscribed: false,
    granted: null as number | null,
    pending: false,
    failure:
      rejectedCode === undefined
        ? (null as { reason: string; code: number | null } | null)
        : { reason: "subscription_rejected", code: rejectedCode },
  };
}

/** One disposable MQTT generation. AccountObservations owns reconnection orchestration. */
export class MiotMqtt {
  readonly generation = crypto.randomUUID();
  private readonly client;
  private readonly topics = new Map<string, ReturnType<typeof entry>>();
  private readonly observers = new Set<Listener>();
  private readonly detachObservers = new Set<() => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private status: "connecting" | "connected" | "closed" = "connecting";
  private reason: string | null = null;
  private inFlight = 0;
  private closing: Promise<void> | undefined;
  private readonly stats = {
    received: 0,
    delivered: 0,
    discarded: 0,
    callback_errors: 0,
  };

  constructor(
    private readonly sourceId: string,
    session: z.infer<typeof oauthSessionSchema>,
    private readonly rejectedTopics: ReadonlyMap<string, number>,
  ) {
    this.client = connect("mqtts://cn-ha.mqtt.io.mi.com:8883", {
      protocolVersion: 5,
      clientId: `miloco:${session.uuid}`,
      username: "2882303761520431603",
      password: session.accessToken,
      clean: true,
      keepalive: 60,
      connectTimeout: 15_000,
      resubscribe: false,
      reconnectPeriod: 0,
      manualConnect: true,
      rejectUnauthorized: true,
      queueQoSZero: false,
    });
    this.client.on("connect", () => {
      if (this.status === "closed") return;
      this.status = "connected";
      this.broadcast(
        connectionObservation(this.sourceId, this.generation, "connected"),
      );
      this.reconcile();
    });
    // Register before CONNECT/SUBSCRIBE; early valid messages are not buffered.
    this.client.on("message", (topic, payload, packet) => {
      if (this.status !== "connected") return;
      this.stats.received++;
      const events = pushObservations(
        topic,
        payload,
        packet.retain,
        this.sourceId,
        this.generation,
      );
      if (!events.length) {
        this.stats.discarded++;
        return;
      }
      for (const event of events) {
        const filter =
          event.kind === "directory"
            ? event.topic
            : deviceTopics(event.did)[event.kind === "property" ? 0 : 1]!;
        const subscription = this.topics.get(filter);
        if (!subscription?.listeners.size) {
          this.stats.discarded++;
          continue;
        }
        // oxlint-disable-next-line unicorn/no-useless-spread -- callbacks may mutate listeners
        for (const listener of [...subscription.listeners]) {
          if (this.closed || !subscription.listeners.has(listener)) continue;
          this.emit(listener, event);
          this.stats.delivered++;
        }
      }
    });
    this.client.on("packetreceive", (packet) => {
      if (
        packet.cmd === "connack" &&
        packet.reasonCode &&
        packet.reasonCode >= 128
      )
        void this.close(`connack_${packet.reasonCode}`);
    });
    this.client.on("disconnect", (packet) => {
      void this.close(`server_disconnect_${packet.reasonCode ?? 0}`);
    });
    this.client.on("error", () => {
      void this.close("connection_failed");
    });
    this.client.on("close", () => {
      void this.close("connection_closed");
    });
    this.client.connect();
  }
  get closed() {
    return this.status === "closed";
  }
  snapshot() {
    return {
      generation: this.generation,
      status: this.status,
      reason: this.reason,
      in_flight: this.inFlight,
      ...this.stats,
      topics: [...this.topics.values()].map((item) => ({
        topic: item.topic,
        desired: item.listeners.size > 0,
        confirmed: item.subscribed,
        granted_qos: item.granted,
        pending: item.pending,
        failure: item.failure,
      })),
    };
  }
  private emit(listener: Listener, event: MiotObservation) {
    try {
      listener(event);
    } catch {
      this.stats.callback_errors++;
    }
  }
  private broadcast(event: MiotObservation) {
    // oxlint-disable-next-line unicorn/no-useless-spread -- callbacks may mutate listeners
    for (const listener of [...this.observers])
      if (this.observers.has(listener)) this.emit(listener, event);
  }
  private report(
    item: ReturnType<typeof entry>,
    status: Parameters<typeof subscriptionObservation>[3],
    reason: string | null = null,
    code: number | null = null,
  ) {
    const event = subscriptionObservation(
      this.sourceId,
      this.generation,
      item.topic,
      status,
      reason,
      code,
    );
    // oxlint-disable-next-line unicorn/no-useless-spread -- callbacks may mutate listeners
    for (const listener of [...item.listeners])
      if (item.listeners.has(listener)) this.emit(listener, event);
  }
  observe(
    deviceIds: readonly string[],
    listener: Listener,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.closed) throw new Error("MQTT instance is closed");
    const binding = this.observeTopics(
      deviceIds.filter(subscribableDevice).flatMap(deviceTopics),
      listener,
      signal,
    );
    for (const did of new Set(deviceIds)) {
      if (signal.aborted || this.closed) break;
      if (subscribableDevice(did)) continue;
      for (const topic of deviceTopics(did)) {
        if (signal.aborted || this.closed) break;
        this.emit(
          listener,
          subscriptionObservation(
            this.sourceId,
            this.generation,
            topic,
            "failed",
            "unsupported_device_id",
          ),
        );
      }
    }
    return binding;
  }
  observeTopics(
    topics: readonly string[],
    listener: Listener,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.closed) throw new Error("MQTT instance is closed");
    const callback: Listener = (event) => {
      if (!signal.aborted) listener(event);
    };
    this.observers.add(callback);
    const selected: ReturnType<typeof entry>[] = [];
    const cancel = () => {
      signal.removeEventListener("abort", cancel);
      this.detachObservers.delete(cancel);
      this.observers.delete(callback);
      for (const item of selected) item.listeners.delete(callback);
      this.reconcile();
    };
    signal.addEventListener("abort", cancel, { once: true });
    this.detachObservers.add(cancel);
    this.emit(
      callback,
      connectionObservation(
        this.sourceId,
        this.generation,
        this.status,
        this.reason,
      ),
    );
    for (const topic of new Set(topics)) {
      if (signal.aborted || !this.observers.has(callback) || this.closed) break;
      let item = this.topics.get(topic);
      if (!item) {
        item = entry(topic, this.rejectedTopics.get(topic));
        this.topics.set(topic, item);
      }
      item.listeners.add(callback);
      selected.push(item);
      this.emit(
        callback,
        subscriptionObservation(
          this.sourceId,
          this.generation,
          topic,
          item.failure ? "failed" : item.subscribed ? "confirmed" : "pending",
          item.failure?.reason ?? null,
          item.failure?.code ?? item.granted,
        ),
      );
    }
    this.reconcile();
    return {
      cancel,
      removeTopics: (removedTopics: readonly string[]) => {
        const removed = new Set(removedTopics);
        for (let index = selected.length - 1; index >= 0; index--) {
          const item = selected[index]!;
          if (!removed.has(item.topic)) continue;
          item.listeners.delete(callback);
          selected.splice(index, 1);
          this.emit(
            callback,
            subscriptionObservation(
              this.sourceId,
              this.generation,
              item.topic,
              "cancelled",
              "scope_invalidated",
            ),
          );
        }
        this.reconcile();
      },
      snapshot: () => this.snapshot(),
      retry: () => this.retry(),
    };
  }
  retry() {
    for (const item of this.topics.values())
      if (item.failure?.reason !== "subscription_rejected") item.failure = null;
    this.reconcile();
  }
  private reconcile() {
    if (this.status !== "connected") return;
    for (const item of this.topics.values()) {
      if (this.inFlight >= CONCURRENCY) break;
      if (item.pending) continue;
      const desired = item.listeners.size > 0;
      if (desired && item.failure) continue;
      if (desired === item.subscribed) {
        if (!desired) this.topics.delete(item.topic);
        continue;
      }
      this.update(item, desired);
    }
  }
  private update(item: ReturnType<typeof entry>, subscribe: boolean) {
    item.pending = true;
    this.inFlight++;
    let finished = false;
    const finish = (reason: string | null, code: number | null = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.timers.delete(timer);
      if (this.closed) return;
      this.inFlight--;
      item.pending = false;
      if (reason) {
        item.failure = { reason, code };
        this.report(item, "failed", reason, code);
        // MQTT.js retains unanswered requests until their ACK or connection shutdown.
        if (!subscribe || reason === "ack_timeout") {
          void this.close(reason);
          return;
        }
      } else {
        item.failure = null;
        item.subscribed = subscribe;
        item.granted = subscribe ? code : null;
        this.report(item, subscribe ? "confirmed" : "cancelled", null, code);
      }
      this.reconcile();
    };
    const timer = setTimeout(() => {
      finish("ack_timeout");
    }, ACK_TIMEOUT);
    timer.unref();
    this.timers.add(timer);
    try {
      if (subscribe) {
        this.client.subscribe(
          item.topic,
          { qos: 2 },
          (error, _grants, packet) => {
            // MQTT.js leaves grants at the requested QoS when SUBACK rejects it.
            const code =
              packet?.granted.length === 1 ? packet.granted[0] : undefined;
            if (typeof code !== "number") {
              finish("subscribe_failed");
              return;
            }
            if (code >= 128)
              finish(
                RETRYABLE_SUBACK_CODES.has(code)
                  ? "subscribe_failed"
                  : "subscription_rejected",
                code,
              );
            else if (error || ![0, 1, 2].includes(code))
              finish("subscribe_failed");
            else finish(null, code);
          },
        );
      } else {
        this.client.unsubscribe(item.topic, (error, packet) => {
          const codes = packet?.cmd === "unsuback" ? packet.granted : undefined;
          if (error || codes?.some((code) => code >= 128)) {
            finish("unsubscribe_failed");
          } else finish(null);
        });
      }
    } catch {
      finish(subscribe ? "subscribe_failed" : "unsubscribe_failed");
    }
  }
  close(reason = "cancelled") {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve();
    this.status = "closed";
    this.reason = reason;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.inFlight = 0;
    for (const item of this.topics.values()) {
      item.pending = false;
      item.subscribed = false;
      this.report(item, "cancelled", reason);
    }
    this.broadcast(
      connectionObservation(this.sourceId, this.generation, "closed", reason),
    );
    // oxlint-disable-next-line unicorn/no-useless-spread -- detach removes itself
    for (const detach of [...this.detachObservers]) detach();
    this.observers.clear();
    this.topics.clear();
    this.closing = this.client.endAsync(true).catch(() => {});
    return this.closing;
  }
}
