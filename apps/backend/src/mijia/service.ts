import { restoreAccountSession, renewAccountSession } from "./account-session";
import type { MiCloud } from "./micloud";
import { LoginFlow, type LoginCandidate } from "./login-flow";
import { context, ROOT_CONTEXT } from "@home-agent/observability";
import type { Operation, ApiError } from "@home-agent/api/contracts";
import type { MijiaState } from "@home-agent/api/mijia";
import type { CredentialStore } from "../credentials/store";
import { MediaSession } from "./media-session";
import { isRecoverableMijiaError, MijiaError, safeMijiaError } from "./errors";
import { RetryTimer } from "./retry-timer";
import { DeviceDiscovery } from "./device-discovery";
import { mijiaOperation } from "./operation";

export type MijiaDependencies = {
  readGo2rtcUrl: () => Promise<string>;
  credentialStore: CredentialStore | undefined;
};

type RestoreTask = { controller: AbortController; promise: Promise<void> };
type AccountTask = {
  account: MiCloud;
  controller: AbortController;
  promise: Promise<void>;
};
const UNKNOWN_EXPIRY_RENEWAL_INTERVAL_MS = 6 * 60 * 60_000;

/** Owns the durable account; only the current task may adopt credentials or media. */
export class MijiaService {
  private state: Pick<MijiaState, "account" | "connectionOperation"> = {
    connectionOperation: null,
    account: { status: "idle" },
  };
  private accountClient: MiCloud | undefined;
  private readonly loginFlow = new LoginFlow((candidate) =>
    this.commitLogin(candidate),
  );
  private lifecycleQueue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  private readonly restoreRetry = new RetryTimer();
  private readonly renewalRetry = new RetryTimer();
  private restoreTask: RestoreTask | undefined;
  private renewalTask: AccountTask | undefined;
  private renewalFailedAccount: MiCloud | undefined;
  private renewalTimer: ReturnType<typeof setTimeout> | undefined;
  private initialRestorePending = false;
  private committingCredentials = false;
  private loggingOut = false;

  private readonly media: MediaSession;
  private readonly discovery: DeviceDiscovery;

  constructor({ readGo2rtcUrl, credentialStore }: MijiaDependencies) {
    this.credentialStore = credentialStore;
    this.media = new MediaSession({
      readUrl: readGo2rtcUrl,
      currentAccount: () => this.accountClient,
      acceptsWork: () => !this.stopped && !this.loggingOut,
      stopped: () => this.stopped,
      canReconfigure: () =>
        !this.stopped && !this.loggingOut && !this.committingCredentials,
      serial: (run) => this.serial(run),
    });
    this.discovery = new DeviceDiscovery({
      currentAccount: () => this.accountClient,
      activeAccount: (account) => this.activeAccount(account),
      stopped: () => this.stopped,
      renewalFailed: (account) => this.renewalFailedAccount === account,
      renew: (account) => this.startRenewal(account),
      retainedChannels: (id) => this.media.retainedChannels(id),
      onDevices: (devices, retryFailed) =>
        this.media.updateDevices(devices, retryFailed),
    });
  }

  private readonly credentialStore: CredentialStore | undefined;

  private requireStore() {
    if (!this.credentialStore) throw new MijiaError("credential_storage");
    return this.credentialStore;
  }

  requestConnection() {
    if (this.stopped || this.loggingOut) throw new MijiaError("stale_session");
    if (this.state.connectionOperation?.status === "running")
      return this.snapshot();
    if (this.committingCredentials || this.initialRestorePending)
      throw new MijiaError("stale_session");
    this.requireStore();
    if (!this.accountClient && this.loginFlow.active)
      throw new MijiaError("not_bound");
    const now = new Date().toISOString();
    const operation: Operation = {
      id: crypto.randomUUID(),
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    this.state.connectionOperation = operation;
    void this.reconnect(operation.id)
      .then((error) => {
        if (!this.isConnectionOperationCurrent(operation.id)) return;
        this.state.connectionOperation = error
          ? {
              ...operation,
              status: "failed",
              error,
              updatedAt: new Date().toISOString(),
            }
          : {
              ...operation,
              status: "succeeded",
              updatedAt: new Date().toISOString(),
            };
      })
      .catch((error: unknown) => {
        if (!this.isConnectionOperationCurrent(operation.id)) return;
        this.state.connectionOperation = {
          ...operation,
          status: "failed",
          error: safeMijiaError(error).toPayload(),
          updatedAt: new Date().toISOString(),
        };
      });
    return this.snapshot();
  }

  private isConnectionOperationCurrent(id: string) {
    return (
      !this.stopped &&
      !this.loggingOut &&
      this.state.connectionOperation?.id === id &&
      this.state.connectionOperation.status === "running"
    );
  }

  private cancelConnectionOperation() {
    const operation = this.state.connectionOperation;
    if (operation?.status === "running")
      this.state.connectionOperation = {
        ...operation,
        status: "cancelled",
        updatedAt: new Date().toISOString(),
      };
  }

  private connectionFailure(): ApiError | undefined {
    if (this.state.account.status !== "authenticated")
      return "error" in this.state.account
        ? this.state.account.error
        : new MijiaError("not_bound").toPayload();
    if (this.media.binding.status !== "ready")
      return "error" in this.media.binding
        ? this.media.binding.error
        : new MijiaError("go2rtc_unavailable").toPayload();
    if (this.discovery.stateSnapshot.status !== "ready")
      return "error" in this.discovery.stateSnapshot
        ? this.discovery.stateSnapshot.error
        : new MijiaError("devices_failed").toPayload();
    return undefined;
  }

  private async reconnect(id: string) {
    const assertCurrent = () => {
      if (!this.isConnectionOperationCurrent(id))
        throw new MijiaError("cancelled");
    };
    await this.media.reconcileConfiguration();
    assertCurrent();
    if (!this.accountClient) {
      this.restoreRetry.cancel();
      await this.startRestore();
      assertCurrent();
      return this.connectionFailure();
    }
    if (this.renewalFailedAccount === this.accountClient) {
      await this.startRenewal(this.accountClient);
      assertCurrent();
      if (
        !this.accountClient ||
        this.renewalFailedAccount === this.accountClient
      )
        return this.connectionFailure();
    }
    if (this.media.binding.status !== "ready") {
      await this.media.retryBinding();
      assertCurrent();
    }
    if (this.discovery.stateSnapshot.status !== "ready") {
      await this.loadDevices();
      assertCurrent();
    }
    return this.connectionFailure();
  }

  private currentRestore(task: RestoreTask) {
    return (
      this.restoreTask === task &&
      !task.controller.signal.aborted &&
      !this.stopped &&
      !this.loggingOut
    );
  }

  private cancelRestore() {
    this.initialRestorePending = false;
    this.restoreRetry.cancel();
    this.restoreTask?.controller.abort();
    this.restoreTask = undefined;
  }

  private activeAccount(account: MiCloud) {
    return this.accountClient === account && !this.stopped && !this.loggingOut;
  }

  private stopAccountMaintenance() {
    clearTimeout(this.renewalTimer);
    this.discovery.pause();
    this.renewalTimer = undefined;
    this.renewalRetry.cancel();
    // Once the durable write starts, its candidate must also become the in-memory
    // account before a queued logout can succeed or fail.
    if (!this.committingCredentials) {
      this.renewalTask?.controller.abort();
      this.renewalTask = undefined;
    }
  }

  private startAccountMaintenance(account: MiCloud) {
    clearTimeout(this.renewalTimer);
    this.discovery.pause();
    this.renewalRetry.cancel();
    this.renewalFailedAccount = undefined;
    if (!this.activeAccount(account)) return;
    const expiresAt = account.exportSession().expiresAt;
    const remaining =
      expiresAt === null ? null : Math.max(0, expiresAt - Date.now());
    // Session cookies have no stated lifetime. Six hours is our revalidation
    // policy, not an inferred Xiaomi expiration time.
    const delay =
      remaining === null
        ? UNKNOWN_EXPIRY_RENEWAL_INTERVAL_MS
        : Math.max(1_000, remaining - Math.min(5 * 60_000, remaining / 2));
    this.renewalTimer = context.with(ROOT_CONTEXT, () =>
      setTimeout(
        () => {
          this.renewalTimer = undefined;
          if (this.activeAccount(account)) void this.startRenewal(account);
        },
        Math.min(delay, 2_147_483_647),
      ),
    );
    this.renewalTimer.unref();
    this.discovery.schedule(account);
  }

  private currentRenewal(task: AccountTask) {
    return (
      this.renewalTask === task &&
      !task.controller.signal.aborted &&
      this.activeAccount(task.account)
    );
  }

  private startRenewal(account: MiCloud) {
    if (!this.activeAccount(account)) return Promise.resolve();
    if (this.renewalTask?.account === account) return this.renewalTask.promise;
    clearTimeout(this.renewalTimer);
    const task: AccountTask = {
      account,
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    this.renewalTask = task;
    let candidate: MiCloud | undefined;
    let reinstall = false;
    task.promise = mijiaOperation(
      "session.renew",
      "authentication",
      async () => {
        const renewed = await renewAccountSession(
          account,
          task.controller.signal,
        );
        candidate = renewed.client;
        const { devices } = renewed;
        await this.serial(async () => {
          if (!this.currentRenewal(task) || !candidate) return;
          const previous = account.getCredentials();
          const next = candidate.getCredentials();
          if (next.userId !== previous.userId)
            throw new MijiaError("authentication");
          this.committingCredentials = true;
          try {
            await mijiaOperation("credentials.save", "credential_storage", () =>
              this.requireStore().write("mijia", candidate!.exportSession()),
            );
            if (this.stopped || this.accountClient !== account) return;
            // Preserve terminal failures until configuration changes or explicit retry.
            reinstall = this.media.needsRebind(
              next.passToken !== previous.passToken,
            );
            if (reinstall) this.media.prepareRebind();
            this.accountClient = candidate;
            account.dispose();
            this.discovery.set(devices, true);
            this.startAccountMaintenance(candidate);
          } finally {
            this.committingCredentials = false;
          }
        });
        if (candidate && this.activeAccount(candidate) && reinstall)
          await this.media.startBinding();
      },
    )
      .catch(async (error: unknown) => {
        if (!this.currentRenewal(task)) return;
        const failure = safeMijiaError(error, "authentication");
        if (failure.reason === "authentication") {
          await this.expireAccount(account, failure);
          return;
        }
        this.renewalFailedAccount = account;
        this.discovery.fail(failure);
        if (isRecoverableMijiaError(error))
          this.renewalRetry.schedule(() => {
            if (this.activeAccount(account)) void this.startRenewal(account);
          });
        else this.renewalRetry.cancel();
      })
      .finally(() => {
        if (candidate !== this.accountClient) candidate?.dispose();
        if (this.renewalTask === task) this.renewalTask = undefined;
      });
    return task.promise;
  }

  private expireAccount(account: MiCloud, failure: MijiaError) {
    return this.serial(async () => {
      if (!this.activeAccount(account)) return;
      this.stopAccountMaintenance();
      this.media.cancelBinding();
      account.dispose();
      this.accountClient = undefined;
      this.media.resetAccount(false);
      this.discovery.reset();
      this.state.account = {
        status: "reauth_required",
        error: failure.toPayload(),
      };
      await this.media.clearAdapter().catch(() => {});
    });
  }

  private startRestore() {
    if (this.restoreTask) return this.restoreTask.promise;
    if (
      this.stopped ||
      this.loggingOut ||
      this.accountClient ||
      this.loginFlow.active
    )
      return Promise.resolve();
    const task: RestoreTask = {
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    this.restoreTask = task;
    this.state.account = { status: "restoring" };
    let cloud: MiCloud | undefined;
    task.promise = mijiaOperation(
      "session.restore",
      "credential_storage",
      async () => {
        const assertActive = () => {
          if (!this.currentRestore(task)) throw new MijiaError("cancelled");
        };
        await this.serial(async () => {
          assertActive();
          const restored = await restoreAccountSession(
            this.requireStore(),
            task.controller.signal,
          );
          cloud = restored?.client;
          assertActive();
          if (!restored) {
            this.state.account = { status: "idle" };
            this.restoreRetry.cancel();
            return;
          }
          const { devices } = restored;
          await mijiaOperation("credentials.save", "credential_storage", () =>
            this.requireStore().write("mijia", cloud!.exportSession()),
          );
          assertActive();
          this.accountClient = restored.client;
          this.discovery.set(devices);
          this.state.account = {
            status: "authenticated",
            id: crypto.randomUUID(),
          };
          this.restoreRetry.cancel();
          this.startAccountMaintenance(restored.client);
        });
        if (this.currentRestore(task) && cloud && this.accountClient === cloud)
          await this.media.startBinding();
        assertActive();
      },
    )
      .catch((error: unknown) => {
        if (!this.currentRestore(task)) return;
        const failure = safeMijiaError(error, "credential_storage");
        this.state.account = {
          status:
            failure.reason === "authentication"
              ? "reauth_required"
              : "restore_error",
          error: failure.toPayload(),
        };
        if (isRecoverableMijiaError(error)) {
          this.restoreRetry.schedule(() => {
            if (
              !this.stopped &&
              !this.loggingOut &&
              !this.accountClient &&
              !this.loginFlow.active
            )
              void this.startRestore();
          });
        } else {
          this.restoreRetry.cancel();
        }
      })
      .finally(() => {
        if (cloud !== this.accountClient) cloud?.dispose();
        if (this.restoreTask === task) this.restoreTask = undefined;
      });
    return task.promise;
  }

  async logout() {
    if (this.stopped || this.loggingOut) throw new MijiaError("stale_session");
    const account = this.accountClient;
    const wasBinding = this.media.bindingPending;
    this.cancelConnectionOperation();
    this.loggingOut = true;
    this.stopAccountMaintenance();
    this.cancelRestore();
    this.media.cancelBinding();
    // A durable login write already in progress must finish selecting the same
    // account in memory before the queued deletion can succeed or fail.
    if (!this.committingCredentials) this.loginFlow.dispose();
    this.media.pauseSources();
    try {
      await this.serial(async () => {
        // Delete durable authorization first. Failure must never report a successful logout.
        try {
          await mijiaOperation("credentials.remove", "credential_storage", () =>
            this.requireStore().remove("mijia"),
          );
          this.loginFlow.dispose();
          this.accountClient?.dispose();
          this.accountClient = undefined;
          this.discovery.reset();
          this.state.account = { status: "idle" };
          this.state.connectionOperation = null;
          this.media.resetAccount();
          await this.media.clearAdapter().catch(() => {});
        } catch (error) {
          const failure = safeMijiaError(error, "credential_storage");
          this.state.account = this.accountClient
            ? this.state.account
            : { status: "restore_error", error: failure.toPayload() };
          this.media.failInstalling(failure);
          throw failure;
        }
      });
    } catch (error) {
      this.loggingOut = false;
      if (this.accountClient) {
        const accountChanged = this.accountClient !== account;
        if (this.media.resumeAfterLogout(wasBinding, accountChanged))
          void this.loadDevices().catch(() => {});
        this.startAccountMaintenance(this.accountClient);
      }
      throw error;
    } finally {
      this.loggingOut = false;
    }
    return this.snapshot();
  }

  private serial<T>(run: () => Promise<T>) {
    const result = this.lifecycleQueue.then(run);
    this.lifecycleQueue = result.catch(() => {});
    return result;
  }

  async initialize() {
    this.initialRestorePending = true;
    this.state.account = { status: "restoring" };
    try {
      await this.media.initialize();
      if (this.initialRestorePending) await this.startRestore();
    } finally {
      this.initialRestorePending = false;
      this.media.startConfigurationChecks();
    }
  }

  snapshot() {
    return structuredClone({
      ...this.state,
      revision: this.media.mediaRevision,
      binding: this.media.binding,
      loginAttempt: this.loginFlow.state,
      devices: this.discovery.snapshot(),
    });
  }

  startLogin() {
    if (this.stopped || this.committingCredentials || this.loggingOut)
      throw new MijiaError("stale_session");
    this.requireStore();
    this.cancelConnectionOperation();
    this.cancelRestore();
    if (!this.accountClient) this.state.account = { status: "idle" };
    this.loginFlow.start();
    return this.snapshot();
  }

  cancelLogin(id: string) {
    if (!this.stopped && !this.loggingOut && !this.committingCredentials)
      this.loginFlow.cancel(id);
    return this.snapshot();
  }

  async verifyLogin(id: string, ticket: string) {
    if (this.stopped || this.loggingOut || this.committingCredentials)
      throw new MijiaError("stale_session");
    await this.loginFlow.verifyLogin(id, ticket);
    return this.snapshot();
  }

  private async commitLogin(attempt: LoginCandidate) {
    if (!this.loginFlow.isCurrent(attempt)) return;
    attempt.cloud.getCredentials();
    this.loginFlow.prepareCommit(attempt);
    await this.serial(async () => {
      if (!this.loginFlow.isCurrent(attempt)) return;
      const previousAccount = this.accountClient;
      this.stopAccountMaintenance();
      this.committingCredentials = true;
      try {
        await mijiaOperation("credentials.save", "credential_storage", () =>
          this.requireStore().write("mijia", attempt.cloud.exportSession()),
        );
        if (!this.loginFlow.isCurrent(attempt)) return;
        this.cancelRestore();
        this.media.resetAccount();
        this.discovery.reset();
        this.accountClient?.dispose();
        this.accountClient = attempt.cloud;
        this.state.account = {
          id: crypto.randomUUID(),
          status: "authenticated",
        };
        this.loginFlow.adopt(attempt);
        this.state.connectionOperation = null;
        this.startAccountMaintenance(attempt.cloud);
      } finally {
        this.committingCredentials = false;
        if (previousAccount && this.activeAccount(previousAccount))
          this.startAccountMaintenance(previousAccount);
      }
    });
    if (
      this.accountClient === attempt.cloud &&
      !this.stopped &&
      !this.loggingOut
    ) {
      await this.media.startBinding();
      if (
        this.accountClient === attempt.cloud &&
        !this.stopped &&
        !this.loggingOut
      )
        void this.loadDevices().catch(() => {});
    }
  }

  async loadDevices() {
    await this.discovery.load();
    return this.snapshot();
  }

  reservePlayback(revision: string, deviceId: string, channel: 1 | 2) {
    return this.media.reservePlayback(revision, deviceId, channel);
  }
  offer(revision: string, id: string, sdp: string, signal: AbortSignal) {
    return this.media.offer(revision, id, sdp, signal);
  }
  playbackSnapshot(id: string) {
    return this.media.playbackSnapshot(id);
  }
  release(id: string) {
    return this.media.release(id);
  }

  async close() {
    this.cancelConnectionOperation();
    this.stopped = true;
    this.stopAccountMaintenance();
    this.cancelRestore();
    this.media.cancelBinding();
    this.loginFlow.dispose();
    this.accountClient?.dispose();
    this.accountClient = undefined;
    this.discovery.reset();
    await this.media.close();
  }
}
