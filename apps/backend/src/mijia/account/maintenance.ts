import { context, ROOT_CONTEXT } from "@home-agent/observability";
import type { MijiaState } from "@home-agent/api/mijia";
import type { CredentialStore } from "../../credentials/store";
import type { MiCloud } from "../protocols/micloud";
import {
  MijiaError,
  isRecoverableMijiaError,
  safeMijiaError,
  mijiaRetryAfter,
} from "../errors";
import { mijiaOperation } from "../operation";
import { RetryTimer } from "../retry-timer";
import { renewAccountSession, restoreAccountSession } from "./session";

export type AccountSessionCandidate = Awaited<
  ReturnType<typeof renewAccountSession>
>;
type RestoreState = Exclude<MijiaState["account"], { status: "authenticated" }>;
type RestoreTask = { controller: AbortController; promise: Promise<void> };
type RenewalTask = RestoreTask & { account: MiCloud };

type MaintenanceDependencies = {
  currentAccount: () => MiCloud | undefined;
  currentOAuth: () => AccountSessionCandidate["oauth"] | undefined;
  isActive: (account: MiCloud) => boolean;
  acceptsWork: () => boolean;
  committing: () => boolean;
  isLoginActive: () => boolean;
  readStore: () => CredentialStore;
  commitRestored: (
    candidate: AccountSessionCandidate,
    assertCurrent: () => void,
  ) => Promise<void>;
  commitRenewed: (
    account: MiCloud,
    candidate: AccountSessionCandidate,
    assertCurrent: () => void,
  ) => Promise<void>;
  onRestoreState: (state: RestoreState) => void;
  onRenewalFailure: (account: MiCloud, failure: MijiaError) => Promise<void>;
};

const UNKNOWN_EXPIRY_RENEWAL_INTERVAL_MS = 6 * 60 * 60_000;

/** Prepares account candidates and owns maintenance work; service alone commits ownership. */
export class AccountMaintenance {
  private readonly restoreRetry = new RetryTimer();
  private readonly renewalRetry = new RetryTimer();
  private restoreTask: RestoreTask | undefined;
  private renewalTask: RenewalTask | undefined;
  private failedAccount: MiCloud | undefined;
  private renewalTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;
  private restoreRetryAfterAt = 0;
  private renewalRetryAfterAt = 0;

  constructor(private readonly deps: MaintenanceDependencies) {}

  private acceptsWork() {
    return !this.stopped && this.deps.acceptsWork();
  }

  private activeAccount(account: MiCloud) {
    return this.acceptsWork() && this.deps.isActive(account);
  }

  private track(promise: Promise<void>) {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }

  renewalFailed(account: MiCloud) {
    return this.failedAccount === account;
  }

  private currentRestore(task: RestoreTask) {
    return (
      this.restoreTask === task &&
      !task.controller.signal.aborted &&
      this.acceptsWork()
    );
  }

  cancelRestore() {
    this.restoreRetry.cancel();
    this.restoreTask?.controller.abort();
    this.restoreTask = undefined;
  }

  retryRestore() {
    if (Date.now() < this.restoreRetryAfterAt) return Promise.resolve();
    this.restoreRetry.cancel();
    return this.restore();
  }

  restore() {
    if (this.restoreTask) return this.restoreTask.promise;
    if (
      !this.acceptsWork() ||
      this.deps.currentAccount() ||
      this.deps.isLoginActive() ||
      Date.now() < this.restoreRetryAfterAt
    )
      return Promise.resolve();
    const task: RestoreTask = {
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    this.restoreTask = task;
    this.deps.onRestoreState({ status: "restoring" });
    let candidate: AccountSessionCandidate | undefined;
    task.promise = this.track(
      mijiaOperation("session.restore", "credential_storage", async () => {
        const assertCurrent = () => {
          if (!this.currentRestore(task)) throw new MijiaError("cancelled");
        };
        candidate = await restoreAccountSession(
          this.deps.readStore(),
          task.controller.signal,
        );
        assertCurrent();
        if (!candidate) {
          this.deps.onRestoreState({ status: "idle" });
          this.restoreRetry.cancel();
          return;
        }
        await this.deps.commitRestored(candidate, assertCurrent);
        assertCurrent();
        this.restoreRetryAfterAt = 0;
        this.restoreRetry.cancel();
      })
        .catch((error: unknown) => {
          if (!this.currentRestore(task)) return;
          const failure = safeMijiaError(error, "credential_storage");
          this.deps.onRestoreState({
            status:
              failure.reason === "authentication"
                ? "reauth_required"
                : "restore_error",
            error: failure.toPayload(),
          });
          this.restoreRetryAfterAt = mijiaRetryAfter(failure);
          if (isRecoverableMijiaError(error)) {
            this.restoreRetry.schedule(() => {
              if (
                this.acceptsWork() &&
                !this.deps.currentAccount() &&
                !this.deps.isLoginActive()
              )
                void this.restore();
            }, this.restoreRetryAfterAt);
          } else {
            this.restoreRetry.cancel();
          }
        })
        .finally(() => {
          if (candidate?.client !== this.deps.currentAccount())
            candidate?.client.dispose();
          if (this.restoreTask === task) this.restoreTask = undefined;
        }),
    );
    return task.promise;
  }

  stopRenewal() {
    clearTimeout(this.renewalTimer);
    this.renewalTimer = undefined;
    this.renewalRetry.cancel();
    // A durable write already underway must finish selecting the same owner in memory.
    if (!this.deps.committing()) {
      this.renewalTask?.controller.abort();
      this.renewalTask = undefined;
    }
  }

  scheduleRenewal(account: MiCloud) {
    clearTimeout(this.renewalTimer);
    this.renewalTimer = undefined;
    this.renewalRetry.cancel();
    if (!this.activeAccount(account)) return;
    // An accepted account replaces any ownerless restore attempt and its deadline.
    this.restoreRetryAfterAt = 0;
    // Resuming the same account after a failed logout/login must not bypass a
    // supplier deadline. A successfully adopted candidate has a new identity.
    if (
      this.failedAccount === account &&
      Date.now() < this.renewalRetryAfterAt
    ) {
      this.renewalRetry.schedule(() => {
        if (this.activeAccount(account)) void this.renew(account);
      }, this.renewalRetryAfterAt);
      return;
    }
    this.failedAccount = undefined;
    this.renewalRetryAfterAt = 0;
    const expiresAt = Math.min(
      account.exportSession().expiresAt ??
        Date.now() + UNKNOWN_EXPIRY_RENEWAL_INTERVAL_MS,
      this.deps.currentOAuth()?.expiresAt ?? Date.now(),
    );
    const remaining = Math.max(0, expiresAt - Date.now());
    const delay = Math.max(
      1_000,
      remaining - Math.min(5 * 60_000, remaining / 2),
    );
    this.renewalTimer = context.with(ROOT_CONTEXT, () =>
      setTimeout(
        () => {
          this.renewalTimer = undefined;
          if (this.activeAccount(account)) void this.renew(account);
        },
        Math.min(delay, 2_147_483_647),
      ),
    );
    this.renewalTimer.unref();
  }

  private currentRenewal(task: RenewalTask) {
    return (
      this.renewalTask === task &&
      !task.controller.signal.aborted &&
      this.activeAccount(task.account)
    );
  }

  renew(account: MiCloud) {
    if (!this.activeAccount(account)) return Promise.resolve();
    if (this.failedAccount === account && Date.now() < this.renewalRetryAfterAt)
      return Promise.resolve();
    if (this.renewalTask?.account === account) return this.renewalTask.promise;
    clearTimeout(this.renewalTimer);
    this.renewalTimer = undefined;
    if (!this.deps.committing()) this.renewalTask?.controller.abort();
    const task: RenewalTask = {
      account,
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    this.renewalTask = task;
    let candidate: AccountSessionCandidate | undefined;
    task.promise = this.track(
      mijiaOperation("session.renew", "authentication", async () => {
        const oauth = this.deps.currentOAuth();
        if (!oauth) throw new MijiaError("authentication");
        candidate = await renewAccountSession(
          account,
          oauth,
          task.controller.signal,
        );
        const assertCurrent = () => {
          if (!this.currentRenewal(task)) throw new MijiaError("cancelled");
        };
        assertCurrent();
        await this.deps.commitRenewed(account, candidate, assertCurrent);
      })
        .catch(async (error: unknown) => {
          if (!this.currentRenewal(task)) return;
          const failure = safeMijiaError(error, "authentication");
          if (failure.reason === "authentication") {
            await this.deps.onRenewalFailure(account, failure);
            return;
          }
          this.failedAccount = account;
          this.renewalRetryAfterAt = mijiaRetryAfter(failure);
          await this.deps.onRenewalFailure(account, failure);
          if (!this.currentRenewal(task)) return;
          if (isRecoverableMijiaError(error))
            this.renewalRetry.schedule(() => {
              if (this.activeAccount(account)) void this.renew(account);
            }, this.renewalRetryAfterAt);
          else this.renewalRetry.cancel();
        })
        .finally(() => {
          if (candidate?.client !== this.deps.currentAccount())
            candidate?.client.dispose();
          if (this.renewalTask === task) this.renewalTask = undefined;
        }),
    );
    return task.promise;
  }

  async shutdown() {
    this.stopped = true;
    this.stopRenewal();
    this.cancelRestore();
    await Promise.allSettled(this.pending);
  }
}
