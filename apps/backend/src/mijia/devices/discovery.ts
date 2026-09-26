import { RetryTimer } from "../retry-timer";
import { householdLimits, jsonBytes } from "../../household/config";
import { context, ROOT_CONTEXT } from "@home-agent/observability";
import type { MijiaState } from "@home-agent/api/mijia";
import type { MiCloud, MiCloudDevice } from "../protocols/micloud";
import { describeMijiaDevice } from "./mapping";
import {
  isRecoverableMijiaError,
  MijiaError,
  mijiaRetryAfter,
  safeMijiaError,
} from "../errors";
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

/** Maintains vendor discovery and the access index for the accepted household. */
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
  private accessHomeId: string | null = null;
  private selectedDevices = new Map<string, MiCloudDevice>();
  private scopeRevision = crypto.randomUUID();
  private confirmed = false;
  private readonly retry = new RetryTimer();
  private retryAccountId: string | undefined;
  private retryAfterAt = 0;
  private pendingCatalog:
    | { account: MiCloud; catalog: Awaited<ReturnType<MiCloud["getCatalog"]>> }
    | undefined;
  get catalogConfirmed() {
    return this.confirmed;
  }

  get revision() {
    return this.scopeRevision;
  }
  private get devices() {
    return [...this.selectedDevices.values()];
  }
  private indexSelectedDevices() {
    this.selectedDevices = new Map(
      this.selectedHome
        ? this.catalog.devices
            .filter((device) => device.home_id === this.accessHomeId)
            .map((device) => [device.did, device])
        : [],
    );
  }
  get selectedHome() {
    return this.catalog.homes.find((home) => home.id === this.accessHomeId);
  }
  homeSnapshot() {
    return {
      selectedHomeId: this.accessHomeId,
      status:
        this.accessHomeId === null
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
    if (this.accessHomeId === null) throw new MijiaError("home_required");
    if (!this.selectedHome) throw new MijiaError("home_unavailable");
    return this.selectedHome;
  }
  validateSelection(homeId: string) {
    if (!this.catalog.homes.some((home) => home.id === homeId))
      throw new MijiaError("home_unavailable");
  }
  acceptHome(homeId: string | null) {
    if (homeId === this.accessHomeId) return;
    this.accessHomeId = homeId;
    this.indexSelectedDevices();
    this.scopeRevision = crypto.randomUUID();
    this.dependencies.onScopeChanged();
    this.state = {
      ...this.state,
      items: this.devices.map(describeMijiaDevice),
    };
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
  revocation(next: Awaited<ReturnType<MiCloud["getCatalog"]>>) {
    const accepted = new Map(
      next.devices.map((device) => [device.did, device]),
    );
    const homeIds = new Set(next.homes.map((home) => home.id));
    const homeLost = Boolean(
      this.selectedHome && !homeIds.has(this.selectedHome.id),
    );
    const remaining = this.catalog.devices.filter((device) => {
      const replacement = accepted.get(device.did);
      return (
        replacement &&
        device.home_id &&
        homeIds.has(device.home_id) &&
        replacement.home_id === device.home_id
      );
    });
    if (remaining.length !== this.catalog.devices.length || homeLost) {
      const retained = new Set(remaining.map((device) => device.did));
      return {
        catalog: {
          homes: this.catalog.homes.filter((item) => homeIds.has(item.id)),
          devices: remaining,
        },
        deviceIds: this.devices
          .filter((device) => homeLost || !retained.has(device.did))
          .map((device) => device.did),
        homeLost,
      };
    }
    return undefined;
  }

  definitionChanges(next: Awaited<ReturnType<MiCloud["getCatalog"]>>) {
    const replacements = new Map(
      next.devices.map((device) => [device.did, device]),
    );
    return this.devices
      .filter((device) => {
        const replacement = replacements.get(device.did);
        return (
          replacement &&
          replacement.home_id === device.home_id &&
          (replacement.model !== device.model ||
            replacement.spec_type !== device.spec_type)
        );
      })
      .map((device) => device.did);
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
    return this.devices;
  }

  find(id: string) {
    return this.selectedDevices.get(id);
  }

  get stateSnapshot() {
    return this.state;
  }
  snapshot() {
    return {
      ...this.state,
      items: this.devices.map(describeMijiaDevice),
    };
  }
  pause() {
    clearTimeout(this.discoveryTimer);
    this.retry.cancel();
    this.discoveryTimer = undefined;
  }
  private retryScope(account: MiCloud) {
    const { region, userId } = account.getCredentials();
    const id = JSON.stringify([region, userId]);
    if (this.retryAccountId !== id) {
      this.retry.cancel();
      this.retryAccountId = id;
      this.retryAfterAt = 0;
    }
    return id;
  }
  private scheduleRetry(account: MiCloud) {
    const id = this.retryScope(account);
    this.retry.schedule(() => {
      const current = this.dependencies.currentAccount();
      if (
        current &&
        this.dependencies.activeAccount(current) &&
        this.retryScope(current) === id
      )
        void this.load(true, true);
    }, this.retryAfterAt);
  }
  reset() {
    this.pause();
    this.retryAccountId = undefined;
    this.retryAfterAt = 0;
    this.loadController?.abort();
    this.confirmed = false;
    this.pendingCatalog = undefined;
    this.catalog = { homes: [], devices: [] };
    this.accessHomeId = null;
    this.selectedDevices.clear();
    this.scopeRevision = crypto.randomUUID();
    this.state = { status: "idle", items: [] };
    this.discoveryFailedAccount = undefined;
    this.deviceLoadTask = undefined;
  }
  fail(error: MijiaError) {
    const account = this.dependencies.currentAccount();
    if (
      account &&
      (error.reason === "home_storage" ||
        error.reason === "home_storage_unconfirmed")
    )
      this.scheduleRetry(account);
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
    this.catalog = catalog;
    if (this.pendingCatalog?.catalog === catalog)
      this.pendingCatalog = undefined;
    this.indexSelectedDevices();
    const devices = this.devices;
    this.state = {
      status: "ready",
      items: devices.map(describeMijiaDevice),
    };
    this.dependencies.onDevices(devices, retryFailed);
    const account = this.dependencies.currentAccount();
    if (account) this.schedule(account);
  }

  async load(background = false, retryStorage = false) {
    const account = this.dependencies.currentAccount();
    if (!account) throw new MijiaError("not_bound");
    this.retryScope(account);
    if (!background) this.discoveryFailedAccount = undefined;
    if (this.deviceLoadTask?.account === account) {
      this.refreshAgain = true;
      await this.deviceLoadTask.promise;
      return this.snapshot();
    }
    const pendingCatalog =
      retryStorage && this.pendingCatalog?.account === account
        ? this.pendingCatalog.catalog
        : undefined;
    // Every trigger shares the supplier deadline; a local save needs no request.
    if (!pendingCatalog && Date.now() < this.retryAfterAt) {
      this.scheduleRetry(account);
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
          pendingCatalog ??
          (await mijiaOperation("devices.list", "devices_failed", () =>
            account.getCatalog(controller.signal),
          ));
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
        this.retryAfterAt = Math.max(
          this.retryAfterAt,
          mijiaRetryAfter(failure),
        );
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
          failure.reason === "home_storage" ||
          failure.reason === "home_storage_unconfirmed"
        ) {
          this.scheduleRetry(account);
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
