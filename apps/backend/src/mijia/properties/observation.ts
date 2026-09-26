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

/** Keeps active observations across disposable connections; owns the only retry timer. */
export class DeviceObservations {
  private connection: MiotMqtt | undefined;
  private readonly watches = new Set<Watch>();
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
        const connection = new MiotMqtt(this.sourceId, this.credentials());
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
    }
  }

  private bind(watch: Watch, connection: MiotMqtt) {
    const binding = connection.observe(
      watch.ids,
      (event) => {
        if (this.connection !== connection || !this.watches.has(watch)) return;
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
