import { context, ROOT_CONTEXT } from "@home-agent/observability";
import type { MijiaState } from "@home-agent/api/mijia";
import type { MiCloud, MiCloudDevice } from "../protocols/micloud";
import { Go2RtcAdapter } from "./go2rtc-adapter";
import { PlaybackManager } from "./playback-manager";
import { CameraSourceManager } from "./camera-source-manager";
import { RetryTimer } from "../retry-timer";
import { MijiaError, isRecoverableMijiaError, safeMijiaError } from "../errors";
import { mijiaOperation } from "../operation";

type BindingTask = {
  account: MiCloud;
  controller: AbortController;
  promise: Promise<void>;
};

type MediaDependencies = {
  onChange: () => void;
  readUrl: () => Promise<string>;
  currentAccount: () => MiCloud | undefined;
  acceptsWork: () => boolean;
  canBind: () => boolean;
  stopped: () => boolean;
  canReconfigure: () => boolean;
};

/** Owns media binding, cleanup order, configuration polling, sources and viewers. */
export class MediaSession {
  private currentState: MijiaState["binding"] = { status: "unbound" };
  get state() {
    return this.currentState;
  }
  private set state(value: MijiaState["binding"]) {
    this.currentState = value;
    this.dependencies.onChange();
  }
  private revision = crypto.randomUUID();
  private mediaAdapter: Go2RtcAdapter | undefined;
  private cameraSources: CameraSourceManager | undefined;
  private devices: MiCloudDevice[] = [];
  private readonly playback = new PlaybackManager(
    (revision, deviceId, channel, signal) =>
      this.preparePlaybackCamera(revision, deviceId, channel, signal),
  );
  private readonly bindingRetry = new RetryTimer();
  private readonly cleanupRetry = new RetryTimer();
  private readonly cleanupTasks = new WeakMap<Go2RtcAdapter, Promise<void>>();
  private cleanupFailureState: MijiaState["binding"] | undefined;
  private bindingTask: BindingTask | undefined;
  private bindingRecoveryError: MijiaError | undefined;
  private configurationTimer: ReturnType<typeof setTimeout> | undefined;
  private desiredMediaUrl: string | undefined;
  private configurationUnavailable = false;
  private configurationTask: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;

  constructor(private readonly dependencies: MediaDependencies) {}

  private serial<T>(run: () => Promise<T>) {
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  get binding() {
    return this.state;
  }
  get mediaRevision() {
    return this.revision;
  }
  get bindingPending() {
    return Boolean(this.bindingTask);
  }
  needsRebind(credentialsChanged: boolean) {
    return (
      (this.state.status === "ready" && credentialsChanged) ||
      this.state.status === "installing" ||
      this.bindingRecoveryError !== undefined
    );
  }

  prepareRebind() {
    this.cancelBinding();
    this.invalidateMedia();
    this.state = { status: "unbound" };
    const adapter = this.mediaAdapter;
    if (adapter) {
      adapter.revoke();
      this.queueCleanup(adapter);
    }
  }

  revokeAccount(clearRecovery = true) {
    this.prepareRebind();
    this.devices = [];
    if (clearRecovery) this.bindingRecoveryError = undefined;
  }

  failInstalling(error: MijiaError) {
    if (this.state.status === "installing")
      this.state = { status: "error", error: error.toPayload() };
  }

  pauseSources() {
    this.cameraSources?.pause();
  }

  resumeAfterLogout(wasBinding: boolean, accountChanged: boolean) {
    const cancelledBinding =
      wasBinding &&
      this.state.status === "error" &&
      this.state.error.code === "mijia_cancelled";
    const refreshDevices =
      accountChanged && (this.state.status === "unbound" || cancelledBinding);
    if (refreshDevices) void this.startBinding();
    else if (this.bindingRecoveryError)
      this.bindingFailed(this.bindingRecoveryError);
    else if (!accountChanged && cancelledBinding) void this.startBinding();
    this.cameraSources?.resume();
    return refreshDevices;
  }

  updateDevices(devices: MiCloudDevice[], retryFailed = false) {
    this.devices = devices;
    void this.cameraSources?.update(devices, retryFailed);
  }

  revokeDevices(ids: readonly string[]) {
    this.playback.releaseForDevices(ids);
  }
  retryBinding() {
    this.bindingRetry.cancel();
    return this.startBinding();
  }

  async initialize() {
    await this.serial(async () => {
      if (this.closing || !this.dependencies.acceptsWork()) return;
      try {
        const url = await this.serviceUrl();
        if (this.closing || !this.dependencies.acceptsWork()) return;
        this.desiredMediaUrl = url;
        this.mediaAdapter = this.newAdapter(url);
        await mijiaOperation("reset", "internal_error", () =>
          this.mediaAdapter!.reset(),
        );
      } catch (error) {
        this.state = {
          status: "error",
          error: safeMijiaError(error, "go2rtc_unavailable").toPayload(),
        };
      }
    });
  }

  startConfigurationChecks() {
    this.scheduleConfigurationCheck();
  }

  close() {
    if (this.closing) return this.closing;
    clearTimeout(this.configurationTimer);
    this.cleanupRetry.cancel();
    this.cancelBinding();
    this.devices = [];
    this.invalidateMedia();
    this.mediaAdapter?.revoke();
    this.closing = this.serial(() => this.releaseAdapter());
    return this.closing;
  }

  private scheduleConfigurationCheck() {
    if (this.closing || this.dependencies.stopped()) return;
    clearTimeout(this.configurationTimer);
    this.configurationTimer = context.with(ROOT_CONTEXT, () =>
      setTimeout(() => {
        void this.reconcileConfiguration()
          .catch(() => {})
          .finally(() => this.scheduleConfigurationCheck());
      }, 3_000),
    );
    this.configurationTimer.unref();
  }

  private async serviceUrl() {
    return (await this.dependencies.readUrl()).replace(/\/$/, "");
  }

  private newAdapter(url: string) {
    const adapter = new Go2RtcAdapter(url, {
      onLost: (error) => {
        if (this.mediaAdapter !== adapter || this.dependencies.stopped())
          return;
        this.invalidateMedia();
        this.bindingFailed(error);
      },
      activePlaybackIds: () => this.playback.activeIds(adapter),
      onPlaybackEnded: (ids) => {
        this.playback.forgetEnded(adapter, ids);
        this.playback.retryReleases(adapter);
      },
    });
    return adapter;
  }

  private invalidateMedia() {
    this.revision = crypto.randomUUID();
    this.dependencies.onChange();
    this.cameraSources?.dispose();
    this.cameraSources = undefined;
    this.playback.invalidate();
  }

  private queueCleanup(adapter: Go2RtcAdapter) {
    // Cleanup stays ordered with media installation without holding account writes.
    if (
      this.closing ||
      this.dependencies.stopped() ||
      this.mediaAdapter !== adapter
    )
      return;
    void this.clearAdapter()
      .then(() => {
        if (this.state.status === "unbound" && !this.configurationUnavailable)
          void this.startBinding();
      })
      .catch(() => {});
  }

  clearAdapter() {
    const adapter = this.mediaAdapter;
    if (!adapter) return this.serial(() => this.releaseAdapter());
    const pending = this.cleanupTasks.get(adapter);
    if (pending) return pending;
    const task = this.serial(async () => {
      if (this.mediaAdapter === adapter) await this.releaseAdapter();
    }).finally(() => this.cleanupTasks.delete(adapter));
    this.cleanupTasks.set(adapter, task);
    return task;
  }

  private async releaseAdapter() {
    const adapter = this.mediaAdapter;
    if (!adapter) return;
    // Retain the previous instance until cleanup succeeds, even if YAML changed.
    try {
      await mijiaOperation("cleanup", "go2rtc_cleanup", () => adapter.close());
    } catch (error) {
      const failure = safeMijiaError(error, "go2rtc_cleanup");
      this.cleanupFailureState = {
        status: "error",
        error: failure.toPayload(),
      };
      this.state = this.cleanupFailureState;
      if (
        !this.closing &&
        !this.dependencies.stopped() &&
        this.mediaAdapter === adapter
      )
        this.cleanupRetry.schedule(() => this.queueCleanup(adapter));
      throw failure;
    }
    this.playback.forgetAdapter(adapter);
    if (this.mediaAdapter === adapter) {
      this.mediaAdapter = undefined;
      this.cleanupRetry.cancel();
      if (
        this.state === this.cleanupFailureState &&
        !this.bindingTask &&
        !this.bindingRecoveryError
      )
        this.state = { status: "unbound" };
      this.cleanupFailureState = undefined;
    }
  }

  reconcileConfiguration() {
    if (!this.configurationTask) {
      this.configurationTask = this.applyConfiguration().finally(() => {
        this.configurationTask = undefined;
      });
    }
    return this.configurationTask;
  }

  private async applyConfiguration() {
    if (this.closing || !this.dependencies.canReconfigure()) return;
    let url: string;
    try {
      url = await this.serviceUrl();
    } catch {
      if (this.closing || !this.dependencies.canReconfigure()) return;
      if (!this.configurationUnavailable) {
        this.configurationUnavailable = true;
        this.cancelBinding();
        this.invalidateMedia();
        this.state = {
          status: "error",
          error: new MijiaError("go2rtc_unavailable").toPayload(),
        };
        await this.serial(async () => {
          if (this.configurationUnavailable)
            await this.releaseAdapter().catch(() => {});
        });
      }
      return;
    }
    if (this.closing || !this.dependencies.canReconfigure()) return;
    if (url === this.desiredMediaUrl && !this.configurationUnavailable) return;
    this.desiredMediaUrl = url;
    this.configurationUnavailable = false;
    this.cancelBinding();
    this.invalidateMedia();
    this.state = { status: "unbound" };
    if (this.dependencies.currentAccount()) await this.startBinding();
  }

  private currentBinding(task: BindingTask) {
    return (
      this.bindingTask === task &&
      !this.closing &&
      this.dependencies.currentAccount() === task.account &&
      this.dependencies.acceptsWork()
    );
  }

  cancelBinding() {
    this.bindingRetry.cancel();
    this.bindingTask?.controller.abort();
    this.bindingTask = undefined;
    if (this.state.status === "installing") {
      this.state = {
        status: "error",
        error: new MijiaError("cancelled").toPayload(),
      };
    }
  }

  private bindingFailed(error: unknown) {
    const failure = safeMijiaError(error, "go2rtc_unavailable");
    this.bindingRecoveryError = isRecoverableMijiaError(error)
      ? failure
      : undefined;
    this.state = { status: "error", error: failure.toPayload() };
    const failedState = this.state;
    const account = this.dependencies.currentAccount();
    if (
      account &&
      this.dependencies.acceptsWork() &&
      this.bindingRecoveryError
    ) {
      this.bindingRetry.schedule(() => {
        void (this.bindingTask?.promise ?? Promise.resolve()).then(() => {
          if (
            this.dependencies.currentAccount() === account &&
            this.state === failedState
          )
            void this.startBinding();
        });
      });
    } else {
      this.bindingRetry.cancel();
    }
  }

  startBinding() {
    const account = this.dependencies.currentAccount();
    if (
      this.closing ||
      !account ||
      !this.dependencies.acceptsWork() ||
      !this.dependencies.canBind()
    )
      return Promise.resolve();
    if (this.bindingTask?.account === account) return this.bindingTask.promise;
    const task: BindingTask = {
      account,
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    this.bindingTask = task;
    this.bindingRecoveryError = undefined;
    this.invalidateMedia();
    this.state = { status: "installing" };
    task.promise = this.serial(async () => {
      if (this.currentBinding(task)) await this.installAccount(task);
    }).finally(() => {
      if (this.bindingTask === task) this.bindingTask = undefined;
    });
    return task.promise;
  }

  private async installAccount(task: BindingTask) {
    try {
      await this.releaseAdapter();
      if (!this.currentBinding(task)) return;
      const url = await this.serviceUrl();
      if (!this.currentBinding(task)) return;
      const adapter = this.newAdapter(url);
      this.mediaAdapter = adapter;
      this.desiredMediaUrl = url;
      await mijiaOperation("credentials.install", "internal_error", () =>
        adapter.install(task.account.getCredentials(), task.controller.signal),
      );
      if (!this.currentBinding(task) || this.mediaAdapter !== adapter) return;
      this.state = { status: "ready" };
      this.bindingRetry.cancel();
      const cameras = new CameraSourceManager(
        adapter,
        this.playback,
        (error) => {
          if (
            this.cameraSources !== cameras ||
            this.mediaAdapter !== adapter ||
            this.dependencies.stopped()
          )
            return;
          this.invalidateMedia();
          this.bindingFailed(error);
        },
      );
      this.cameraSources = cameras;
      await cameras.update(this.devices);
    } catch (error) {
      if (this.currentBinding(task)) this.bindingFailed(error);
    }
  }

  private requireReady(revision: string) {
    if (revision !== this.revision) throw new MijiaError("stale_session");
    if (!this.dependencies.acceptsWork()) throw new MijiaError("cancelled");
    if (
      !this.dependencies.currentAccount() ||
      this.state.status !== "ready" ||
      !this.mediaAdapter ||
      !this.cameraSources
    )
      throw new MijiaError("go2rtc_unavailable");
    return { adapter: this.mediaAdapter, cameras: this.cameraSources };
  }

  reservePlayback(revision: string, deviceId: string, channel: 1 | 2) {
    this.requireReady(revision).cameras.validate(deviceId, channel);
    return this.playback.reserve(revision, deviceId, channel);
  }

  private async preparePlaybackCamera(
    revision: string,
    deviceId: string,
    channel: 1 | 2,
    signal: AbortSignal,
  ) {
    const { adapter, cameras } = this.requireReady(revision);
    await mijiaOperation("session.renew_lease", "go2rtc_lost", () =>
      adapter.renewSessionLease(signal),
    );
    this.requireReady(revision);
    const camera = await cameras.prepare(deviceId, channel);
    if (signal.aborted) throw new MijiaError("cancelled");
    if (this.requireReady(revision).adapter !== adapter)
      throw new MijiaError("stale_session");
    return camera;
  }

  offer(revision: string, id: string, sdp: string, signal: AbortSignal) {
    this.requireReady(revision);
    return this.playback.offer(revision, id, sdp, signal);
  }

  playbackSnapshot(id: string) {
    return this.playback.snapshot(id);
  }

  release(id: string) {
    return this.playback.release(id);
  }
}
