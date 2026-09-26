import { context, ROOT_CONTEXT } from "@home-agent/observability";
import { MiotMqtt } from "../protocols/miot/mqtt";
import type { MiotObservation } from "../protocols/miot/messages";

type Watch = {
  selection:
    | { kind: "devices"; ids: readonly string[] }
    | { kind: "topics"; topics: readonly string[] };
  listener: (event: MiotObservation) => void;
  signal: AbortSignal;
  detach: () => void;
  binding?: ReturnType<MiotMqtt["observe"]>;
};

/** Keeps active observations across disposable connections; owns the only retry timer. */
export class DeviceObservations {
  private connection: MiotMqtt | undefined;
  private readonly watches = new Set<Watch>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delay = 1_000;
  private stopped = false;
  private connecting = false;
  private authenticationFailed = false;

  constructor(
    private readonly sourceId: string,
    private readonly credentials: () => ConstructorParameters<
      typeof MiotMqtt
    >[1],
    private readonly onAuthenticationFailure: () => void,
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
      await this.connection?.close();
      if (this.stopped || !this.watches.size || this.authenticationFailed)
        return;
      const connection = new MiotMqtt(this.sourceId, this.credentials());
      this.connection = connection;
      for (const watch of this.watches) this.bind(watch, connection);
    } catch {
      this.authenticationFailed = true;
      this.onAuthenticationFailure();
    } finally {
      this.connecting = false;
    }
  }

  private bind(watch: Watch, connection: MiotMqtt) {
    const listener: Watch["listener"] = (event) => {
      if (this.connection !== connection || !this.watches.has(watch)) return;
      if (event.kind === "connection") {
        if (event.status === "connected") this.delay = 1_000;
        if (event.status === "closed") {
          if (
            [
              "connack_134",
              "connack_135",
              "connack_138",
              "server_disconnect_135",
            ].includes(event.reason ?? "")
          ) {
            if (!this.authenticationFailed) {
              this.authenticationFailed = true;
              this.onAuthenticationFailure();
            }
          } else this.schedule();
        }
      }
      watch.listener(event);
    };
    watch.binding =
      watch.selection.kind === "devices"
        ? connection.observe(watch.selection.ids, listener, watch.signal)
        : connection.observeTopics(
            watch.selection.topics,
            listener,
            watch.signal,
          );
  }

  observe(
    ids: readonly string[],
    listener: Watch["listener"],
    signal: AbortSignal,
  ) {
    return this.watch({ kind: "devices", ids: [...ids] }, listener, signal);
  }
  observeTopics(
    topics: readonly string[],
    listener: Watch["listener"],
    signal: AbortSignal,
  ) {
    return this.watch(
      { kind: "topics", topics: [...topics] },
      listener,
      signal,
    );
  }
  private watch(
    selection: Watch["selection"],
    listener: Watch["listener"],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.stopped) throw new Error("Device observations are closed");
    const watch: Watch = {
      selection,
      listener,
      signal,
      detach: () => signal.removeEventListener("abort", cancel),
    };
    const cancel = () => {
      watch.detach();
      this.watches.delete(watch);
      watch.binding?.cancel();
      if (!this.watches.size) void this.close("cancelled");
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
        observers: this.watches.size,
      }),
      retry: () => {
        if (!this.stopped && !this.authenticationFailed)
          this.connection?.retry();
      },
    };
  }

  credentialsUpdated() {
    if (this.stopped || !this.watches.size) return;
    this.authenticationFailed = false;
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
  }
}
