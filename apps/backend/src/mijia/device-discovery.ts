import { context, ROOT_CONTEXT } from "@home-agent/observability";
import type { MijiaState } from "@home-agent/api/mijia";
import type { MiCloud, MiCloudDevice } from "./micloud";
import { describeMijiaDevices } from "./devices";
import { isRecoverableMijiaError, MijiaError, safeMijiaError } from "./errors";
import { mijiaOperation } from "./operation";

const DEVICE_DISCOVERY_INTERVAL_MS = 5 * 60_000;

type DeviceDependencies = {
  currentAccount: () => MiCloud | undefined;
  activeAccount: (account: MiCloud) => boolean;
  stopped: () => boolean;
  renewalFailed: (account: MiCloud) => boolean;
  renew: (account: MiCloud) => Promise<void>;
  retainedChannels: (id: string) => (1 | 2)[];
  onDevices: (devices: MiCloudDevice[], retryFailed: boolean) => void;
};

/** Owns the device snapshot, discovery timer and coalesced discovery work. */
export class DeviceDiscovery {
  private state: MijiaState["devices"] = { status: "idle", items: [] };
  private devices: MiCloudDevice[] = [];
  private deviceLoadTask:
    | { account: MiCloud; promise: Promise<void> }
    | undefined;
  private discoveryFailedAccount: MiCloud | undefined;
  private discoveryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly dependencies: DeviceDependencies) {}

  get stateSnapshot() {
    return this.state;
  }
  snapshot() {
    return {
      ...this.state,
      items: describeMijiaDevices(
        this.devices,
        this.dependencies.retainedChannels,
      ),
    };
  }
  pause() {
    clearTimeout(this.discoveryTimer);
    this.discoveryTimer = undefined;
  }
  reset() {
    this.pause();
    this.devices = [];
    this.state = { status: "idle", items: [] };
    this.discoveryFailedAccount = undefined;
    this.deviceLoadTask = undefined;
  }
  fail(error: MijiaError) {
    this.state = {
      status: "error",
      items: this.state.items,
      error: error.toPayload(),
    };
  }

  schedule(account: MiCloud) {
    clearTimeout(this.discoveryTimer);
    if (
      !this.dependencies.activeAccount(account) ||
      this.discoveryFailedAccount === account
    )
      return;
    const confirmingOffline = describeMijiaDevices(this.devices, (id) =>
      this.dependencies.retainedChannels(id),
    ).some((device) => device.retainedChannels.length > 0);
    this.discoveryTimer = context.with(ROOT_CONTEXT, () =>
      setTimeout(
        () => {
          this.discoveryTimer = undefined;
          if (
            !this.dependencies.activeAccount(account) ||
            this.dependencies.renewalFailed(account)
          )
            return;
          void this.load(true)
            .catch(() => {})
            .finally(() => {
              if (this.dependencies.activeAccount(account))
                this.schedule(account);
            });
        },
        confirmingOffline ? 15_000 : DEVICE_DISCOVERY_INTERVAL_MS,
      ),
    );
    this.discoveryTimer.unref();
  }

  set(devices: MiCloudDevice[], retryFailed = false) {
    this.discoveryFailedAccount = undefined;
    this.devices = devices;
    this.state = {
      status: "ready",
      items: describeMijiaDevices(devices),
    };
    this.dependencies.onDevices(devices, retryFailed);
    const account = this.dependencies.currentAccount();
    if (account) this.schedule(account);
  }

  async load(background = false) {
    const account = this.dependencies.currentAccount();
    if (!account) throw new MijiaError("not_bound");
    if (!background) this.discoveryFailedAccount = undefined;
    if (this.deviceLoadTask?.account === account) {
      await this.deviceLoadTask.promise;
      return this.snapshot();
    }
    if (this.dependencies.renewalFailed(account)) {
      if (!background) await this.dependencies.renew(account);
      return this.snapshot();
    }
    if (!background)
      this.state = {
        status: "loading",
        items: this.state.items,
      };
    const operation = (async () => {
      try {
        const devices = await mijiaOperation(
          "devices.list",
          "devices_failed",
          () => account.getDevices(),
        );
        if (
          this.dependencies.currentAccount() !== account ||
          this.dependencies.stopped()
        )
          return;
        this.set(devices, true);
      } catch (error) {
        if (
          this.dependencies.currentAccount() !== account ||
          this.dependencies.stopped()
        )
          return;
        const failure = safeMijiaError(error, "devices_failed");
        if (failure.reason === "authentication") {
          this.state = {
            status: "error",
            items: this.state.items,
            error: failure.toPayload(),
          };
          await this.dependencies.renew(account);
          return;
        }
        if (!isRecoverableMijiaError(error))
          this.discoveryFailedAccount = account;
        this.state = {
          status: "error",
          items: this.state.items,
          error: failure.toPayload(),
        };
      }
    })();
    this.deviceLoadTask = { account, promise: operation };
    await operation;
    if (this.deviceLoadTask?.promise === operation)
      this.deviceLoadTask = undefined;
    if (this.dependencies.activeAccount(account)) this.schedule(account);
    return this.snapshot();
  }
}
