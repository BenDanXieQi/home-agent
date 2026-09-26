import { context, ROOT_CONTEXT } from "@home-agent/observability";
import { directoryTopics } from "../protocols/miot/messages";
import type { AccountObservations } from "../account/observations";

const DIRECTORY_DEBOUNCE_MS = 5_000;

/** Account-wide directory invalidations; current household filtering happens on commit. */
export class DirectoryNotifications {
  private controller: AbortController | undefined;
  private binding: ReturnType<AccountObservations["observeTopics"]> | undefined;
  private owner: AccountObservations | undefined;
  private key = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private received = 0;
  private lastReceivedAt: string | null = null;
  private failures = new Set<string>();
  private confirmed = new Set<string>();
  private topics = new Set<string>();

  constructor(private readonly refresh: () => Promise<unknown>) {}

  update(owner: AccountObservations, uid: string, ids: readonly string[]) {
    const topics = directoryTopics(uid, ids).toSorted();
    const key = JSON.stringify(topics);
    if (owner === this.owner && key === this.key) return;
    const previous = this.controller;
    const controller = new AbortController();
    this.controller = controller;
    this.owner = owner;
    this.key = key;
    this.topics = new Set(topics);
    this.confirmed.clear();
    this.failures.clear();
    this.binding = owner.observeTopics(
      topics,
      (event) => {
        if (this.controller !== controller || controller.signal.aborted) return;
        if (event.kind === "directory") {
          if (!this.topics.has(event.topic)) return;
          this.received++;
          this.lastReceivedAt = event.received_at;
          this.schedule();
        } else if (event.kind === "connection") {
          if (event.status === "connected") this.schedule();
          else {
            this.confirmed.clear();
            this.failures.clear();
          }
        } else if (event.kind === "subscription") {
          if (event.status === "confirmed") {
            this.confirmed.add(event.topic);
            this.failures.delete(event.topic);
          } else {
            this.confirmed.delete(event.topic);
            if (event.status === "failed") this.failures.add(event.topic);
          }
        }
      },
      controller.signal,
    );
    // Attach the replacement first so a shared connection never loses its last owner.
    previous?.abort();
  }

  private schedule() {
    clearTimeout(this.timer);
    const controller = this.controller;
    this.timer = context.with(ROOT_CONTEXT, () =>
      setTimeout(() => {
        this.timer = undefined;
        if (this.controller !== controller || controller?.signal.aborted)
          return;
        void this.refresh().catch(() => {});
      }, DIRECTORY_DEBOUNCE_MS),
    );
    this.timer.unref();
  }

  snapshot() {
    const connection = this.binding?.snapshot();
    return {
      status: connection?.status ?? "inactive",
      reconnect_scheduled: connection?.reconnect_scheduled ?? false,
      authentication_failed: connection?.authentication_failed ?? false,
      topics: this.topics.size,
      confirmed: this.confirmed.size,
      failed: this.failures.size,
      refresh_pending: this.timer !== undefined,
      received: this.received,
      last_received_at: this.lastReceivedAt,
    };
  }

  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.binding = undefined;
    this.owner = undefined;
    this.key = "";
    this.topics.clear();
    this.confirmed.clear();
    this.failures.clear();
    this.received = 0;
    this.lastReceivedAt = null;
  }
}
