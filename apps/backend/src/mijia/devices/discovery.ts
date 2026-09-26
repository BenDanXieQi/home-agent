import { RetryTimer } from "../retry-timer";
import { householdLimits, jsonBytes } from "../../household/config";
import { context, ROOT_CONTEXT } from "@home-agent/observability";
import type { MijiaState } from "@home-agent/api/mijia";
import type { MiCloud, MiCloudDevice } from "../protocols/micloud";
import { describeMijiaDevices } from "./mapping";
import { isRecoverableMijiaError, MijiaError, safeMijiaError } from "../errors";
import { mijiaOperation } from "../operation";

const DEVICE_DISCOVERY_INTERVAL_MS = 5 * 60_000;

type DeviceDependencies = {
  onChange: () => void;
  commit: (
    catalog: Awaited<ReturnType<MiCloud["getCatalog"]>>,
    account: MiCloud,
    assertCurrent: () => void,
  ) => Promise<void>;
  currentAccount: () => MiCloud | undefined;
  activeAccount: (account: MiCloud) => boolean;
  stopped: () => boolean;
  renewalFailed: (account: MiCloud) => boolean;
  renew: (account: MiCloud) => Promise<void>;
  onScopeChanged: () => void;
  onDevices: (devices: MiCloudDevice[], retryFailed: boolean) => void;
};

/** Owns the account catalog, selected household scope and discovery work. */
export class DeviceDiscovery {
  private currentState: MijiaState["devices"] = { status: "idle", items: [] };
  get state() {
    return this.currentState;
  }
  private set state(value: MijiaState["devices"]) {
    this.currentState = value;
    this.dependencies.onChange();
  }
  private catalog: Awaited<ReturnType<MiCloud["getCatalog"]>> = {
    homes: [],
    devices: [],
  };
  private selectedHomeId: string | null = null;
  private scopeRevision = crypto.randomUUID();
  private confirmed = false;
  private readonly retry = new RetryTimer();
  private pendingCatalog:
    | { account: MiCloud; catalog: Awaited<ReturnType<MiCloud["getCatalog"]>> }
    | undefined;
  get ready() {
    return this.confirmed;
  }

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
  catalogSnapshot() {
    return this.catalog;
  }
  retain(
    catalog: Awaited<ReturnType<MiCloud["getCatalog"]>>,
    account: MiCloud,
  ) {
    this.pendingCatalog = undefined;
    if (jsonBytes(catalog) > householdLimits.directoryBytes)
      throw new MijiaError("capacity_exceeded");
    this.pendingCatalog = { account, catalog };
  }
  suspend() {
    this.pause();
    this.confirmed = false;
    this.pendingCatalog = undefined;
    this.loadController?.abort();
    this.scopeRevision = crypto.randomUUID();
    this.state = { status: "loading", items: [] };
  }
  revoke(next: Awaited<ReturnType<MiCloud["getCatalog"]>>) {
    const accepted = new Map(
      next.devices.map((device) => [device.did, device]),
    );
    const home = this.selectedHomeId;
    const remaining = this.catalog.devices.filter((device) => {
      const replacement = accepted.get(device.did);
      return (
        replacement &&
        replacement.home_id === device.home_id &&
        replacement.model === device.model &&
        replacement.spec_type === device.spec_type
      );
    });
    if (
      remaining.length !== this.catalog.devices.length ||
      (home && !next.homes.some((item) => item.id === home))
    ) {
      this.set({
        homes: this.catalog.homes.filter((item) =>
          next.homes.some((candidate) => candidate.id === item.id),
        ),
        devices: remaining,
      });
    }
  }
  private loadController: AbortController | undefined;
  private refreshAgain = false;
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
      items: describeMijiaDevices(this.devices),
    };
  }
  pause() {
    clearTimeout(this.discoveryTimer);
    this.retry.cancel();
    this.discoveryTimer = undefined;
  }
  reset() {
    this.pause();
    this.loadController?.abort();
    this.confirmed = false;
    this.pendingCatalog = undefined;
    this.catalog = { homes: [], devices: [] };
    this.selectedHomeId = null;
    this.scopeRevision = crypto.randomUUID();
    this.state = { status: "idle", items: [] };
    this.discoveryFailedAccount = undefined;
    this.deviceLoadTask = undefined;
  }
  fail(error: MijiaError) {
    const account = this.dependencies.currentAccount();
    if (account && error.reason === "home_storage")
      this.retry.schedule(() => {
        if (this.dependencies.activeAccount(account))
          void this.load(true, true);
      });
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
    this.discoveryTimer = context.with(ROOT_CONTEXT, () =>
      setTimeout(() => {
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
      }, DEVICE_DISCOVERY_INTERVAL_MS),
    );
    this.discoveryTimer.unref();
  }

  set(
    catalog: Awaited<ReturnType<MiCloud["getCatalog"]>>,
    retryFailed = false,
  ) {
    this.confirmed = true;
    this.retry.cancel();
    this.discoveryFailedAccount = undefined;
    const previousHome = this.selectedHome?.id;
    const previousDevices = this.devices;
    this.catalog = catalog;
    if (this.pendingCatalog?.catalog === catalog)
      this.pendingCatalog = undefined;
    const remaining = new Set(this.devices.map((device) => device.did));
    if (
      previousHome !== this.selectedHome?.id ||
      previousDevices.some((device) => {
        const next = this.devices.find((item) => item.did === device.did);
        return (
          !remaining.has(device.did) ||
          next?.model !== device.model ||
          next?.spec_type !== device.spec_type ||
          next?.home_id !== device.home_id
        );
      })
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

  async load(background = false, retryStorage = false) {
    const account = this.dependencies.currentAccount();
    if (!account) throw new MijiaError("not_bound");
    if (!background) this.discoveryFailedAccount = undefined;
    if (this.deviceLoadTask?.account === account) {
      this.refreshAgain = true;
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
    const controller = new AbortController();
    this.loadController = controller;
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (
        this.dependencies.currentAccount() !== account ||
        this.dependencies.stopped()
      )
        throw new MijiaError("stale_session");
    };
    const operation = (async () => {
      try {
        const catalog =
          retryStorage && this.pendingCatalog?.account === account
            ? this.pendingCatalog.catalog
            : await mijiaOperation("devices.list", "devices_failed", () =>
                account.getCatalog(controller.signal),
              );
        if (
          this.dependencies.currentAccount() !== account ||
          this.dependencies.stopped()
        )
          return;
        assertCurrent();
        await this.dependencies.commit(catalog, account, assertCurrent);
        if (this.pendingCatalog?.catalog === catalog)
          this.pendingCatalog = undefined;
      } catch (error) {
        if (controller.signal.aborted) return;
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
        if (
          isRecoverableMijiaError(error) ||
          failure.reason === "home_storage"
        ) {
          this.retry.schedule(() => {
            if (this.dependencies.activeAccount(account))
              void this.load(true, true);
          });
        } else this.discoveryFailedAccount = account;
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
    if (this.dependencies.activeAccount(account)) {
      this.schedule(account);
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.load(true);
      }
    }
    return this.snapshot();
  }
}
