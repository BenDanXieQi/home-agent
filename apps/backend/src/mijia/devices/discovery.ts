import { context, ROOT_CONTEXT } from "@home-agent/observability";
import type { MijiaState } from "@home-agent/api/mijia";
import type { MiCloud, MiCloudDevice } from "../protocols/micloud";
import { describeMijiaDevices } from "./mapping";
import { isRecoverableMijiaError, MijiaError, safeMijiaError } from "../errors";
import { mijiaOperation } from "../operation";

const DEVICE_DISCOVERY_INTERVAL_MS = 5 * 60_000;

type DeviceDependencies = {
  currentAccount: () => MiCloud | undefined;
  activeAccount: (account: MiCloud) => boolean;
  stopped: () => boolean;
  renewalFailed: (account: MiCloud) => boolean;
  renew: (account: MiCloud) => Promise<void>;
  retainedChannels: (id: string) => (1 | 2)[];
  onScopeChanged: () => void;
  onDevices: (devices: MiCloudDevice[], retryFailed: boolean) => void;
};

/** Owns the account catalog, selected household scope and discovery work. */
export class DeviceDiscovery {
  private state: MijiaState["devices"] = { status: "idle", items: [] };
  private catalog: Awaited<ReturnType<MiCloud["getCatalog"]>> = {
    homes: [],
    devices: [],
  };
  private selectedHomeId: string | null = null;
  private scopeRevision = crypto.randomUUID();

  get revision() {
    return this.scopeRevision;
  }
  private get devices() {
    return this.selectedHome
      ? this.catalog.devices.filter(
          (device) => device.home_id === this.selectedHomeId,
        )
      : [];
  }
  get selectedHome() {
    return this.catalog.homes.find((home) => home.id === this.selectedHomeId);
  }
  homeSnapshot() {
    return {
      selectedHomeId: this.selectedHomeId,
      status:
        this.selectedHomeId === null
          ? ("unselected" as const)
          : this.selectedHome
            ? ("selected" as const)
            : ("unavailable" as const),
      items: this.catalog.homes.map(({ id, name, shared }) => ({
        id,
        name,
        shared,
      })),
    };
  }
  requireHome() {
    if (this.selectedHomeId === null) throw new MijiaError("home_required");
    if (!this.selectedHome) throw new MijiaError("home_unavailable");
    return this.selectedHome;
  }
  validateSelection(homeId: string | null) {
    if (homeId === null) return;
    if (this.state.status !== "ready") throw new MijiaError("devices_failed");
    if (!this.catalog.homes.some((home) => home.id === homeId))
      throw new MijiaError("home_unavailable");
  }
  select(homeId: string | null) {
    if (homeId === this.selectedHomeId) return;
    this.selectedHomeId = homeId;
    this.scopeRevision = crypto.randomUUID();
    this.dependencies.onScopeChanged();
    this.state = { ...this.state, items: describeMijiaDevices(this.devices) };
    this.dependencies.onDevices(this.devices, false);
  }
  private deviceLoadTask:
    | { account: MiCloud; promise: Promise<void> }
    | undefined;
  private discoveryFailedAccount: MiCloud | undefined;
  private discoveryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly dependencies: DeviceDependencies) {}

  list() {
    return [...this.devices];
  }

  find(id: string) {
    return this.devices.find((device) => device.did === id);
  }

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
    this.catalog = { homes: [], devices: [] };
    this.selectedHomeId = null;
    this.scopeRevision = crypto.randomUUID();
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

  set(
    catalog: Awaited<ReturnType<MiCloud["getCatalog"]>>,
    retryFailed = false,
  ) {
    this.discoveryFailedAccount = undefined;
    const previousHome = this.selectedHome?.id;
    const previousDevices = this.devices;
    this.catalog = catalog;
    const remaining = new Set(this.devices.map((device) => device.did));
    if (
      previousHome !== this.selectedHome?.id ||
      previousDevices.some((device) => !remaining.has(device.did))
    ) {
      this.scopeRevision = crypto.randomUUID();
      this.dependencies.onScopeChanged();
    }
    const devices = this.devices;
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
        const catalog = await mijiaOperation(
          "devices.list",
          "devices_failed",
          () => account.getCatalog(),
        );
        if (
          this.dependencies.currentAccount() !== account ||
          this.dependencies.stopped()
        )
          return;
        this.set(catalog, true);
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
