import { context, ROOT_CONTEXT } from "@home-agent/observability";
import { MiotMqtt, isMqttAuthenticationFailure } from "../protocols/miot/mqtt";
import type { MiotObservation } from "../protocols/miot/messages";
import { safeMijiaError } from "../errors";
import { mijiaOperation } from "../operation";

type Watch = {
  ids: readonly string[];
  listener: (event: MiotObservation) => void;
  signal: AbortSignal;
  detach: () => void;
  binding?: ReturnType<MiotMqtt["observe"]>;
};

/** Owns observations, topic authorization failures and connection recovery. */
export class DeviceObservations {
  private connection: MiotMqtt | undefined;
  private readonly watches = new Set<Watch>();
  private readonly rejectedTopics = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delay = 1_000;
  private stopped = false;
  private connecting = false;
  private authenticationFailed = false;
  private failure: ReturnType<typeof safeMijiaError>["reason"] | null = null;

  constructor(
    private readonly sourceId: string,
    private readonly credentials: () => ConstructorParameters<
      typeof MiotMqtt
    >[1],
    private readonly onAuthenticationFailure: () => void,
    private readonly onPermissionRejected: (
      event: Extract<MiotObservation, { kind: "subscription" }>,
    ) => void,
  ) {}

  get closed() {
    return this.stopped;
  }

  private schedule() {
    if (
      this.stopped ||
      this.authenticationFailed ||
      !this.watches.size ||
      this.timer
    )
      return;
    const delay = this.delay;
    this.delay = Math.min(this.delay * 2, 120_000);
    this.timer = context.with(ROOT_CONTEXT, () =>
      setTimeout(() => {
        this.timer = undefined;
        void this.connect();
      }, delay),
    );
    this.timer.unref();
  }

  private async connect() {
    if (this.connecting || this.stopped || !this.watches.size) return;
    this.connecting = true;
    try {
      await mijiaOperation("mqtt.connect", "internal_error", async () => {
        await this.connection?.close();
        if (this.stopped || !this.watches.size || this.authenticationFailed)
          return;
        // This attempt uses current credentials, including updates during close.
        clearTimeout(this.timer);
        this.timer = undefined;
        const connection = new MiotMqtt(
          this.sourceId,
          this.credentials(),
          this.rejectedTopics,
        );
        this.connection = connection;
        for (const watch of this.watches) {
          if (this.stopped || connection.closed) break;
          this.bind(watch, connection);
        }
      });
    } catch (error) {
      if (this.stopped || !this.watches.size) return;
      const failure = safeMijiaError(error);
      this.failure = failure.reason;
      if (
        failure.reason === "cancelled" ||
        failure.reason === "stale_session"
      ) {
        await this.close(failure.reason);
      } else if (failure.reason === "authentication") {
        this.authenticationFailed = true;
        this.onAuthenticationFailure();
      } else {
        await this.connection?.close(failure.reason);
        this.schedule();
      }
    } finally {
      this.connecting = false;
      // A synchronous callback can replace the last watch while this attempt closes.
      if (this.connection?.closed) this.schedule();
    }
  }

  private bind(watch: Watch, connection: MiotMqtt) {
    const binding = connection.observe(
      watch.ids,
      (event) => {
        if (this.connection !== connection || !this.watches.has(watch)) return;
        if (
          event.kind === "subscription" &&
          event.status === "failed" &&
          event.reason === "subscription_rejected" &&
          event.code !== null &&
          !this.rejectedTopics.has(event.topic)
        ) {
          this.rejectedTopics.set(event.topic, event.code);
          // Topic ACL rejection is not evidence that the account token is invalid.
          if (event.code === 0x87) this.onPermissionRejected(event);
        }
        if (event.kind === "connection") {
          if (event.status === "connected") {
            this.delay = 1_000;
            this.failure = null;
          }
          if (event.status === "closed") {
            if (isMqttAuthenticationFailure(event.reason)) {
              if (!this.authenticationFailed) {
                this.authenticationFailed = true;
                this.onAuthenticationFailure();
              }
            } else this.schedule();
          }
        }
        if (this.connection === connection && this.watches.has(watch))
          watch.listener(event);
      },
      watch.signal,
    );
    // observe delivers events synchronously; callbacks may cancel this watch.
    if (
      this.stopped ||
      !this.watches.has(watch) ||
      watch.signal.aborted ||
      this.connection !== connection ||
      connection.closed
    )
      binding.cancel();
    else watch.binding = binding;
  }

  observe(
    ids: readonly string[],
    listener: Watch["listener"],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.stopped) throw new Error("Device observations are closed");
    const watch: Watch = {
      ids: [...ids],
      listener,
      signal,
      detach: () => signal.removeEventListener("abort", cancel),
    };
    const cancel = () => {
      watch.detach();
      this.watches.delete(watch);
      watch.binding?.cancel();
      if (!this.watches.size) {
        clearTimeout(this.timer);
        this.timer = undefined;
        void this.connection?.close("cancelled");
      }
    };
    this.watches.add(watch);
    signal.addEventListener("abort", cancel, { once: true });
    if (this.connection && !this.connection.closed)
      this.bind(watch, this.connection);
    else if (!this.timer && !this.authenticationFailed) void this.connect();
    return {
      cancel,
      snapshot: () => ({
        ...this.connection?.snapshot(),
        reconnect_scheduled: this.timer !== undefined,
        authentication_failed: this.authenticationFailed,
        failure: this.failure,
        observers: this.watches.size,
      }),
      retry: () => {
        if (!this.stopped && !this.authenticationFailed)
          this.connection?.retry();
      },
    };
  }

  credentialsUpdated() {
    if (this.stopped) return;
    this.authenticationFailed = false;
    this.failure = null;
    this.rejectedTopics.clear();
    if (!this.watches.size) return;
    void this.connection?.close("credentials_updated");
    this.schedule();
  }

  async close(reason = "cancelled") {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.connection?.close(reason);
    for (const watch of this.watches) watch.detach();
    this.watches.clear();
    this.rejectedTopics.clear();
  }
}
