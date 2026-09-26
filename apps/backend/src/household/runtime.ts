import { createActor } from "xstate";
import {
  directorySchema,
  snapshotSchema,
  deviceSchema,
  entityKey,
} from "@home-agent/api/household";
import type {
  DirectoryRefreshTarget,
  Projection,
} from "@home-agent/api/household";
import { householdMachine } from "./machine";
import { householdLimits, jsonBytes } from "./config";
import { publicDirectory } from "./projection";
import { HouseholdSpecifications } from "./specifications";
import type { HouseholdRepository } from "./repository";
import type { MijiaService } from "../mijia/service";
import type { deviceDirectory } from "../mijia/devices/directory";
import { MijiaError, safeMijiaError } from "../mijia/errors";

export class HouseholdRuntime {
  private readonly actor = createActor(householdMachine);
  private readonly listeners = new Set<() => void>();
  private readonly specs = new HouseholdSpecifications(
    () => this.publishSpecs(),
    (bytes) => {
      const { home, room, device } = this.projection;
      const accepted =
        jsonBytes({ home, room, device }) + bytes <=
        householdLimits.directoryBytes;
      if (!accepted)
        this.publish({
          ...this.projection,
          projection_health: {
            projection_health: {
              ...this.projection.projection_health.projection_health,
              capacity_degraded: true,
            },
          },
        });
      return accepted;
    },
  );
  private unsubscribe: (() => void) | undefined;
  private handled = 0;
  private switching = false;
  private leaving = false;
  private stopped = false;
  private cached = false;
  private accountInstance: string | null = null;
  private refreshTask: Promise<void> | undefined;
  private refreshEpoch: string | undefined;
  private pendingRefresh: { directory: boolean; specs: boolean } | undefined;
  private savedCandidate: ReturnType<typeof deviceDirectory> | undefined;
  private cachedSnapshot: ReturnType<typeof snapshotSchema.parse> | undefined;

  constructor(
    readonly service: MijiaService,
    private readonly repository: HouseholdRepository | undefined,
  ) {
    service.attachHousehold({
      restore: (id, home) => this.restore(id, home),
      commit: (candidate, assert) => this.commitDirectory(candidate, assert),
      ready: () => this.ready,
      specification: (id) => this.specification(id),
    });
  }
  start() {
    let published = this.version();
    this.actor.subscribe(({ context }) => {
      if (
        context.scope_epoch !== published.scope_epoch ||
        context.sequence !== published.sequence
      ) {
        published = this.version();
        for (const listener of this.listeners) listener();
      }
      if (context.input_sequence === this.handled) return;
      this.handled = context.input_sequence;
      for (const effect of context.effects) {
        const epoch = context.scope_epoch;
        if (effect.kind === "select") {
          this.switching = true;
          this.refreshTask = undefined;
          this.refreshEpoch = undefined;
          this.pendingRefresh = undefined;
          this.cached = false;
          this.savedCandidate = undefined;
          this.specs.clear();
          this.service.suspendHousehold();
          void this.service
            .selectHome(effect.home_id, () => this.assertEpoch(epoch))
            .catch((error) => this.fail(epoch, error, "selection"))
            .finally(() => {
              if (this.epoch === epoch) {
                this.switching = false;
                this.syncService();
              }
            });
        } else this.refresh(effect.target, epoch);
      }
    });
    this.actor.start();
    this.unsubscribe = this.service.subscribe(() => this.syncService());
    this.syncService();
  }
  get epoch() {
    return this.actor.getSnapshot().context.scope_epoch;
  }
  get ready() {
    return (
      this.projection.household.household.status === "running" &&
      !this.leaving &&
      !this.stopped
    );
  }
  private get projection() {
    return this.actor.getSnapshot().context.projection;
  }
  snapshot() {
    const { scope_epoch, sequence, projection } =
      this.actor.getSnapshot().context;
    if (
      this.cachedSnapshot?.scope_epoch !== scope_epoch ||
      this.cachedSnapshot.sequence !== sequence
    )
      this.cachedSnapshot = snapshotSchema.parse({
        scope_epoch,
        sequence,
        projection,
      });
    return this.cachedSnapshot;
  }
  changes() {
    return this.actor.getSnapshot().context.changes;
  }
  version() {
    const { scope_epoch, sequence } = this.actor.getSnapshot().context;
    return { scope_epoch, sequence };
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(projection: Projection, newScope = false) {
    if (!this.stopped)
      this.actor.send({
        type: "publish",
        scope_epoch: this.epoch,
        projection,
        newScope,
      });
  }
  private assertEpoch(epoch: string) {
    if (this.stopped || epoch !== this.epoch)
      throw new MijiaError("stale_session");
  }
  selectHome(epoch: string, home_id: string | null) {
    this.assertEpoch(epoch);
    this.service.validateHome(home_id);
    if (this.service.snapshot().account.status !== "authenticated")
      throw new MijiaError("not_bound");
    this.actor.send({
      type: "command",
      scope_epoch: epoch,
      effect: { kind: "select", home_id },
    });
    return { state_version: this.version() };
  }
  requestRefresh(epoch: string, target: DirectoryRefreshTarget) {
    this.assertEpoch(epoch);
    if (
      this.service.snapshot().account.status !== "authenticated" ||
      this.switching
    )
      throw new MijiaError("stale_session");
    const household = this.projection.household.household;
    if (
      household.status === "initializing" &&
      household.stage === "selection"
    ) {
      if (target === "specs") throw new MijiaError("invalid_state");
      return this.selectHome(epoch, household.home_id);
    }
    this.actor.send({
      type: "command",
      scope_epoch: epoch,
      effect: { kind: "refresh", target },
    });
    return { state_version: this.version() };
  }
  private refresh(target: DirectoryRefreshTarget, epoch: string) {
    if (this.refreshTask) {
      this.pendingRefresh = {
        directory:
          (this.pendingRefresh?.directory ?? false) || target !== "specs",
        specs: (this.pendingRefresh?.specs ?? false) || target !== "directory",
      };
      return;
    }
    this.refreshEpoch = epoch;
    this.refreshTask = (async () => {
      if (target !== "specs") await this.service.loadDevices();
      this.assertEpoch(epoch);
      if (target !== "directory" && this.savedCandidate)
        this.specs.update(this.savedCandidate.devices, true);
      this.publishSpecs();
    })()
      .catch((error) => this.fail(epoch, error, "directory"))
      .finally(() => {
        if (this.refreshEpoch !== epoch) return;
        this.refreshTask = undefined;
        const pending = this.pendingRefresh;
        this.pendingRefresh = undefined;
        if (pending && this.epoch === epoch && !this.stopped)
          this.refresh(
            pending.directory ? (pending.specs ? "all" : "directory") : "specs",
            epoch,
          );
      });
  }
  private async restore(accountId: string, homeId: string | null) {
    const epoch = this.epoch;
    const stored = homeId
      ? await this.repository?.read(accountId, homeId)
      : undefined;
    this.assertEpoch(epoch);
    this.cached = true;
    const directory = stored
      ? directorySchema.parse(stored.directory)
      : { home: {}, room: {}, device: {} };
    const homes = {
      selectedHomeId: homeId,
      status: homeId ? ("selected" as const) : ("unselected" as const),
      items: Object.values(directory.home).map((home) => ({
        id: home.home_id,
        name: home.name,
        shared: home.shared,
      })),
    };
    this.publish({
      ...this.projection,
      ...directory,
      household: {
        household: {
          ...this.projection.household.household,
          account_id: accountId,
          home_id: homeId,
          homes,
          status: "initializing",
          stage: "account",
          sync_status: "unsynced",
          saved_at: stored?.savedAt ?? null,
        },
      },
    });
  }
  private async commitDirectory(
    candidate: ReturnType<typeof deviceDirectory>,
    assertCurrent: () => void,
  ) {
    const epoch = this.epoch;
    const assert = () => {
      this.assertEpoch(epoch);
      assertCurrent();
      // Discovery only records persisted access. The actor owns an in-progress
      // selection, including its target when persistence has failed.
      const household = this.projection.household.household;
      if (
        household.stage === "selection" &&
        (candidate.accountId !== household.account_id ||
          candidate.homeId !== household.home_id)
      )
        throw new MijiaError("stale_session");
    };
    assert();
    const now = new Date().toISOString();
    const directory = publicDirectory(candidate, now);
    const nextHouse = {
      ...this.projection.household.household,
      account_id: candidate.accountId,
      home_id: candidate.homeId,
      homes: {
        selectedHomeId: candidate.homeId,
        status:
          candidate.homeId === null
            ? ("unselected" as const)
            : candidate.homes.some((home) => home.id === candidate.homeId)
              ? ("selected" as const)
              : ("unavailable" as const),
        items: candidate.homes.map(({ id, name, shared }) => ({
          id,
          name,
          shared,
        })),
      },
      cloud_synced_at: now,
    };
    if (
      jsonBytes({ ...directory, spec: this.projection.spec }) >
      householdLimits.directoryBytes
    ) {
      this.publish({
        ...this.projection,
        projection_health: {
          projection_health: {
            ...this.projection.projection_health.projection_health,
            capacity_degraded: true,
          },
        },
      });
      throw new MijiaError("capacity_exceeded");
    }
    let savedAt: string | null = null;
    try {
      if (!this.repository) throw new MijiaError("home_storage");
      if (candidate.homeId)
        savedAt = await this.repository.save(
          candidate.accountId,
          candidate.homeId,
          directory,
          assert,
        );
      assert();
    } catch (error) {
      const failure = safeMijiaError(error, "home_storage");
      const capacity = failure.reason === "capacity_exceeded";
      if (this.epoch === epoch)
        this.publish({
          ...this.projection,
          household: {
            household: {
              ...this.projection.household.household,
              cloud_synced_at: now,
              error: failure.toPayload(),
              sync_status: "error",
            },
          },
          projection_health: {
            projection_health: {
              ...this.projection.projection_health.projection_health,
              storage_degraded: !capacity,
              capacity_degraded: capacity,
            },
          },
        });
      throw failure;
    }
    return () => {
      assert();
      this.cached = false;
      this.savedCandidate = candidate;
      this.specs.update(candidate.devices);
      const status =
        nextHouse.homes.status === "selected"
          ? ("running" as const)
          : ("waiting_for_home" as const);
      this.publish({
        ...this.projection,
        ...directory,
        ...this.withSpecifications(directory.device),
        household: {
          household: {
            ...nextHouse,
            status,
            stage: "ready",
            sync_status: "synced",
            saved_at: savedAt,
            error: null,
          },
        },
        projection_health: {
          projection_health: {
            storage_degraded: false,
            capacity_degraded: false,
          },
        },
      });
    };
  }
  private withSpecifications(devices: Projection["device"]) {
    const { specs, references } = this.specs.snapshot();
    const device = Object.fromEntries(
      Object.entries(devices).map(([key, value]) => {
        const spec_id = references.get(value.id) ?? null;
        const spec = spec_id ? specs[spec_id] : undefined;
        const capabilities = Object.entries(spec?.spec ?? {});
        const capability_tags = [
          ...(["readable", "writeable", "notify"] as const).filter((tag) =>
            capabilities.some(([, capability]) => capability[tag]),
          ),
          ...(["action", "event"] as const).filter((tag) =>
            capabilities.some(([id]) => id.startsWith(`${tag}.`)),
          ),
        ];
        return [
          key,
          deviceSchema.parse({
            ...value,
            spec_id,
            category: spec?.category ?? null,
            capability_tags,
          }),
        ];
      }),
    );
    return { device, spec: specs };
  }
  private publishSpecs() {
    if (this.stopped || !this.savedCandidate) return;
    this.publish({
      ...this.projection,
      ...this.withSpecifications(this.projection.device),
    });
  }
  private syncService() {
    if (this.stopped) return;
    const state = this.service.snapshot();
    const identity = this.service.identity();
    const before = this.projection;
    const instance =
      state.account.status === "authenticated" ? state.account.id : null;
    const replacedAccount =
      instance !== null &&
      this.accountInstance !== null &&
      instance !== this.accountInstance;
    if (
      instance !== null ||
      ["idle", "reauth_required"].includes(state.account.status)
    )
      this.accountInstance = instance;
    let next: Projection = {
      ...before,
      household: { household: { ...before.household.household } },
      account: { account: state.account },
      login: { login: this.service.loginPublic() },
      connection: { connection: state.connectionOperation },
      media: { media: { revision: state.revision, binding: state.binding } },
    };
    const changedAccount =
      replacedAccount ||
      (identity !== null &&
        identity !== before.household.household.account_id) ||
      (identity === null &&
        ["idle", "reauth_required"].includes(state.account.status) &&
        before.household.household.account_id !== null);
    if (changedAccount && !this.switching) {
      this.specs.clear();
      this.savedCandidate = undefined;
      this.cached = false;
      this.refreshTask = undefined;
      this.refreshEpoch = undefined;
      this.pendingRefresh = undefined;
      next = {
        ...next,
        home: {},
        room: {},
        device: {},
        spec: {},
        latest: {},
        source_health: {},
        rule_status: {},
        household: {
          household: {
            ...next.household.household,
            account_id: identity,
            home_id: state.homes.selectedHomeId,
            homes: state.homes,
            status: identity ? "initializing" : "unbound",
            stage: "account",
            error: null,
            sync_status: "unsynced",
            cloud_synced_at: null,
            saved_at: null,
          },
        },
      };
    }
    if (!this.switching && !this.cached && !this.leaving) {
      const current = this.service.directorySnapshot();
      if (current && next.household.household.account_id === identity) {
        const available = new Set(current.devices.map((device) => device.id));
        if (
          this.savedCandidate &&
          this.savedCandidate.devices.some(
            (device) => !available.has(device.id),
          )
        ) {
          this.savedCandidate = {
            ...this.savedCandidate,
            devices: this.savedCandidate.devices.filter((device) =>
              available.has(device.id),
            ),
          };
          this.specs.update(this.savedCandidate.devices);
        }
        const device = Object.fromEntries(
          Object.entries(next.device).filter(([, value]) =>
            available.has(value.id),
          ),
        );
        const specIds = new Set(
          Object.values(device).map((value) => value.spec_id),
        );
        next = {
          ...next,
          device,
          spec: Object.fromEntries(
            Object.entries(next.spec).filter(([key]) => specIds.has(key)),
          ),
          household: {
            household: {
              ...next.household.household,
              homes:
                next.household.household.status === "initializing" &&
                next.household.household.stage === "selection"
                  ? {
                      ...state.homes,
                      selectedHomeId: next.household.household.home_id,
                    }
                  : state.homes,
            },
          },
        };
        if (
          state.homes.status !== "selected" &&
          next.household.household.status === "running"
        )
          next.household.household = {
            ...next.household.household,
            status: "waiting_for_home",
            home_id: state.homes.selectedHomeId,
          };
      }
    }
    if (
      state.account.status === "restore_error" ||
      state.account.status === "reauth_required"
    )
      next.household.household = {
        ...next.household.household,
        error: state.account.error,
        sync_status: "error",
      };
    if (state.devices.status === "error")
      next.household.household = {
        ...next.household.household,
        error: state.devices.error,
        sync_status: "error",
      };
    else if (
      state.devices.status === "loading" &&
      next.household.household.sync_status !== "error"
    )
      next.household.household = {
        ...next.household.household,
        sync_status: "syncing",
      };
    if (
      state.devices.status === "error" &&
      state.devices.error.code === "mijia_capacity_exceeded"
    )
      next.projection_health = {
        projection_health: {
          ...next.projection_health.projection_health,
          capacity_degraded: true,
        },
      };
    const lostHome =
      !this.switching &&
      before.household.household.status === "running" &&
      state.homes.status === "unavailable";
    if (lostHome) {
      this.specs.clear();
      this.savedCandidate = undefined;
      next = {
        ...next,
        home: {},
        room: {},
        device: {},
        spec: {},
        latest: {},
        source_health: {},
        rule_status: {},
        household: {
          household: {
            ...next.household.household,
            status: "waiting_for_home",
            sync_status: "error",
            error: new MijiaError("home_unavailable").toPayload(),
          },
        },
      };
    }
    this.publish(next, (changedAccount && !this.switching) || lostHome);
  }
  private fail(
    epoch: string,
    error: unknown,
    stage: "selection" | "directory",
  ) {
    if (epoch !== this.epoch || this.stopped) return;
    this.publish({
      ...this.projection,
      household: {
        household: {
          ...this.projection.household.household,
          stage,
          error: safeMijiaError(
            error,
            stage === "selection" ? "home_storage" : "devices_failed",
          ).toPayload(),
          sync_status: "error",
        },
      },
    });
  }
  private specification(id: string) {
    const device =
      this.projection.device[entityKey(this.service.identity() ?? "", id)];
    if (!device) throw new MijiaError("device_not_found");
    const spec = device.spec_id
      ? this.projection.spec[device.spec_id]
      : undefined;
    if (!spec || (spec.status !== "ready" && !Object.keys(spec.spec).length))
      throw new MijiaError("spec_unavailable");
    return {
      did: device.id,
      name: device.name,
      home: device.home_name ?? "",
      room: device.room_name ?? "",
      model: device.model,
      online: device.online,
      category: spec.category,
      spec: spec.spec,
    };
  }
  reservePlayback(epoch: string, revision: string, id: string, channel: 1 | 2) {
    this.assertEpoch(epoch);
    if (
      !this.ready ||
      !this.projection.device[entityKey(this.service.identity()!, id)]
    )
      throw new MijiaError("devices_failed");
    return this.service.reservePlayback(revision, id, channel);
  }
  async logout() {
    this.leaving = true;
    this.cached = false;
    this.savedCandidate = undefined;
    this.specs.clear();
    this.publish(
      {
        ...this.projection,
        home: {},
        room: {},
        device: {},
        spec: {},
        latest: {},
        source_health: {},
        rule_status: {},
        household: {
          household: {
            ...this.projection.household.household,
            status: "initializing",
            stage: "account",
            sync_status: "unsynced",
            error: null,
          },
        },
      },
      true,
    );
    try {
      await this.service.logout();
    } catch (error) {
      this.fail(this.epoch, error, "selection");
      throw error;
    } finally {
      this.leaving = false;
      this.syncService();
    }
  }
  async close() {
    this.actor.send({ type: "stop" });
    this.stopped = true;
    this.specs.clear();
    this.unsubscribe?.();
    await this.service.close();
    this.actor.stop();
    this.listeners.clear();
  }
}
