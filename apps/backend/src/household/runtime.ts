import { createActor, type EventFromLogic } from "xstate";
import { produce } from "@home-agent/api/immutable";
import {
  directorySchema,
  entityKey,
  initialSpecification,
  selectHomeSchema,
} from "@home-agent/api/household";
import type {
  DirectoryRefreshTarget,
  Projection,
} from "@home-agent/api/household";
import { householdMachine } from "./machine";
import { householdLimits, jsonBytes } from "./config";
import { publicDirectory } from "./directory";
import type { DirectoryCandidate } from "./directory";
import { HouseholdSpecifications, specificationBytes } from "./specifications";
import type { HouseholdRepository } from "./repository";
import type { HouseholdSource } from "./source";
import { HouseholdError } from "./errors";
import { directoryFits, projectionBytes } from "./capacity";

export class HouseholdRuntime {
  private readonly actor = createActor(householdMachine);
  private readonly listeners = new Set<() => void>();
  private readonly specs;
  private unsubscribe: (() => void) | undefined;
  private handled = 0;
  private started = false;
  private closing: Promise<void> | undefined;
  private bindingHome = false;
  private logoutTask: Promise<void> | undefined;
  private readonly refreshTasks = new Map<
    DirectoryRefreshTarget,
    { epoch: string; promise: Promise<void> }
  >();
  private readonly summaries = new WeakMap<
    ReturnType<HouseholdSpecifications["snapshot"]>["specs"][string]["spec"],
    {
      category: string | null;
      capability_tags: Projection["device"][string]["capability_tags"];
    }
  >();
  private memory = process.memoryUsage();
  private memoryPeak = this.memory.heapUsed;
  private memorySampledAt = new Date().toISOString();
  private memoryTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly source: HouseholdSource,
    private readonly repository: HouseholdRepository | undefined,
    loader: ConstructorParameters<typeof HouseholdSpecifications>[0],
  ) {
    this.specs = new HouseholdSpecifications(
      loader,
      (deviceIds) => this.publishSpecifications(deviceIds),
      (candidate) => {
        if (
          specificationBytes(candidate.specs) <=
          householdLimits.specificationBytes
        )
          return true;
        this.reportCapacity();
        return false;
      },
    );
  }
  private get context() {
    return this.actor.getSnapshot().context;
  }
  private get projection() {
    return this.context.projection;
  }
  private get stopped() {
    return this.actor.getSnapshot().matches("stopping");
  }
  get epoch() {
    return this.context.scope_epoch;
  }
  get ready() {
    return this.actor.getSnapshot().matches("running");
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    let published = this.version();
    this.actor.subscribe(({ context }) => {
      if (context.input_sequence === this.handled) return;
      // Mark the commit before calling subscribers, including reentrant consumers.
      this.handled = context.input_sequence;
      if (
        context.scope_epoch !== published.scope_epoch ||
        context.sequence !== published.sequence
      ) {
        published = {
          scope_epoch: context.scope_epoch,
          sequence: context.sequence,
        };
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            console.warn("Household state subscriber failed");
          }
        }
      }
      for (const effect of context.effects) {
        try {
          if (effect.kind === "reset") this.resetResources();
          else if (effect.kind === "logout") {
            this.resetResources();
            this.logoutTask = this.leave(context.operation_id!);
          } else this.refresh(effect.target, context.scope_epoch);
        } catch (error) {
          this.fail(context.scope_epoch, error, "directory");
        }
      }
    });
    this.actor.start();
    this.unsubscribe = this.source.subscribe(() => this.syncSource());
    this.syncSource();
    this.memoryTimer = setInterval(
      () => this.sampleMemory(),
      householdLimits.memorySampleMs,
    );
    this.memoryTimer.unref();
  }
  private sampleMemory() {
    this.memory = process.memoryUsage();
    this.memoryPeak = Math.max(this.memoryPeak, this.memory.heapUsed);
    this.memorySampledAt = new Date().toISOString();
  }
  diagnostics() {
    return {
      state_version: this.version(),
      bytes: {
        ...projectionBytes(this.projection),
        specifications: specificationBytes(this.specs.snapshot().specs),
      },
      memory: {
        ...this.memory,
        peak_heap_used: this.memoryPeak,
        sampled_at: this.memorySampledAt,
      },
    };
  }
  snapshot() {
    const { scope_epoch, sequence, projection } = this.context;
    // Every record is already white-listed and identity-checked by the commit.
    return { scope_epoch, sequence, projection };
  }
  changes() {
    return this.context.changes;
  }
  version() {
    const { scope_epoch, sequence } = this.context;
    return { scope_epoch, sequence };
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(projection: Projection) {
    if (this.stopped) return;
    this.actor.send({ type: "publish", scope_epoch: this.epoch, projection });
  }
  private reportCapacity() {
    this.publish(
      produce(this.projection, (draft) => {
        draft.projection_health.projection_health.capacity_degraded = true;
      }),
    );
  }
  private assertEpoch(epoch: string) {
    if (this.stopped || epoch !== this.epoch)
      throw new HouseholdError("stale_session");
  }
  private command(
    event: Extract<
      EventFromLogic<typeof householdMachine>,
      { type: "command" }
    >,
  ) {
    const input_sequence = this.context.input_sequence + 1;
    const receipt: { context?: HouseholdRuntime["context"] } = {};
    const subscription = this.actor.subscribe(({ context }) => {
      if (context.input_sequence === input_sequence) receipt.context = context;
    });
    try {
      this.actor.send(event);
    } finally {
      subscription.unsubscribe();
    }
    // Effects may queue further inputs; only this command's commit is its receipt.
    const context = receipt.context;
    if (!context?.accepted) throw new HouseholdError("invalid_state");
    return {
      state_version: {
        scope_epoch: context.scope_epoch,
        sequence: context.sequence,
      },
    };
  }
  setupHomes() {
    if (this.projection.household.household.home_id !== null)
      return { items: [] };
    if (this.source.snapshot().account.status !== "authenticated")
      throw new HouseholdError("not_bound");
    const items = this.source.snapshot().homes.items;
    if (jsonBytes(items) > householdLimits.metadataBytes)
      throw new HouseholdError("capacity_exceeded");
    return { items };
  }
  async bindHome(
    epoch: string,
    homeId: ReturnType<typeof selectHomeSchema.parse>["home_id"],
  ) {
    this.assertEpoch(epoch);
    const home = selectHomeSchema.shape.home_id.parse(homeId);
    if (this.bindingHome || this.context.operation)
      throw new HouseholdError("invalid_state");
    const bound = this.projection.household.household.home_id;
    if (bound !== null) throw new HouseholdError("binding_conflict");
    this.bindingHome = true;
    try {
      await this.source.bindHome(home, () => this.assertEpoch(epoch));
      this.assertEpoch(epoch);
      this.actor.send({ type: "bound", scope_epoch: epoch, home_id: home });
      this.refresh("directory", epoch);
      return { state_version: this.version() };
    } finally {
      this.bindingHome = false;
    }
  }
  requestRefresh(epoch: string, target: DirectoryRefreshTarget) {
    this.assertEpoch(epoch);
    if (
      this.projection.account.account.status !== "authenticated" ||
      this.context.operation ||
      this.bindingHome
    )
      throw new HouseholdError("stale_session");
    return this.command({
      type: "command",
      scope_epoch: epoch,
      effect: { kind: "refresh", target },
    });
  }
  private refresh(target: DirectoryRefreshTarget, epoch: string) {
    if (this.refreshTasks.get(target)?.epoch === epoch) return;
    const task = {
      epoch,
      promise: Promise.resolve()
        .then(async () => {
          if (target !== "specs") await this.source.refreshDirectory();
          this.assertEpoch(epoch);
          if (target !== "directory") await this.specs.refresh();
        })
        .catch((error) => this.fail(epoch, error, "directory")),
    };
    this.refreshTasks.set(target, task);
    void task.promise.finally(() => {
      if (this.refreshTasks.get(target) === task)
        this.refreshTasks.delete(target);
    });
  }
  async restore(accountId: string, homeId: string | null) {
    const epoch = this.epoch;
    let storageDegraded = false;
    const stored = homeId
      ? await this.repository?.read(accountId, homeId).catch(() => {
          storageDegraded = true;
          return undefined;
        })
      : undefined;
    this.assertEpoch(epoch);
    this.actor.send({
      type: "restore",
      scope_epoch: epoch,
      account_id: accountId,
      home_id: homeId,
      provider: this.source.snapshot().provider,
      directory: stored
        ? directorySchema.parse(stored.directory)
        : { home: {}, room: {}, device: {} },
      saved_at: stored?.savedAt ?? null,
    });
    if (storageDegraded)
      this.publish(
        produce(this.projection, (draft) => {
          draft.projection_health.projection_health.storage_degraded = true;
        }),
      );
  }
  async commitDirectory(
    candidate: DirectoryCandidate,
    assertCurrent: () => void,
  ) {
    const epoch = this.epoch;
    const assert = () => {
      this.assertEpoch(epoch);
      assertCurrent();
      const household = this.projection.household.household;
      if (
        household.home_id !== null &&
        (candidate.accountId !== household.account_id ||
          candidate.homeId !== household.home_id)
      )
        throw new HouseholdError("stale_session");
    };
    assert();
    const now = new Date().toISOString();
    const directory = publicDirectory(candidate, now);
    const provider = this.source.snapshot().provider;
    const household = produce(this.projection.household.household, (draft) => {
      draft.provider = provider;
      draft.account_id = candidate.accountId;
      draft.home_id = candidate.homeId;
      draft.homes = {
        selectedHomeId: candidate.homeId,
        status:
          candidate.homeId === null
            ? "unselected"
            : candidate.homes.some((home) => home.id === candidate.homeId)
              ? "selected"
              : "unavailable",
      };
      draft.cloud_synced_at = now;
      draft.error =
        draft.homes.status === "unavailable"
          ? this.source.failure(new HouseholdError("home_unavailable"))
          : null;
    });
    const candidateProjection = () => ({
      ...this.projection,
      ...directory,
      ...this.withSpecifications(directory.device),
      household: { household },
    });
    if (
      !directoryFits({
        ...directory,
        ...this.withSpecifications(directory.device),
      })
    ) {
      this.reportCapacity();
      throw new HouseholdError("capacity_exceeded");
    }
    let savedAt = this.projection.household.household.saved_at;
    let storageDegraded = false;
    try {
      if (!this.repository) throw new HouseholdError("home_storage");
      if (candidate.homeId)
        savedAt = await this.repository.save(
          candidate.accountId,
          candidate.homeId,
          directory,
          assert,
        );
      assert();
    } catch {
      assert();
      storageDegraded = true;
    }
    return () => {
      assert();
      const projection = candidateProjection();
      this.actor.send({
        type: "directory",
        scope_epoch: epoch,
        projection: produce(projection, (draft) => {
          draft.household.household.saved_at = savedAt;
          draft.projection_health.projection_health.storage_degraded =
            storageDegraded;
          draft.projection_health.projection_health.capacity_degraded = false;
        }),
      });
      assert();
      if (!this.context.accepted) throw new HouseholdError("capacity_exceeded");
      this.specs.retain(new Set(candidate.devices.map((device) => device.id)));
      // Specification preparation cannot block an already accepted directory.
      this.specs.update(candidate.devices);
      this.publishSpecifications();
    };
  }
  revoke(candidate: DirectoryCandidate, assertCurrent: () => void) {
    assertCurrent();
    const epoch = this.epoch;
    const household = this.projection.household.household;
    if (candidate.accountId !== household.account_id)
      throw new HouseholdError("stale_session");
    const homeLost =
      household.home_id !== null &&
      !candidate.homes.some((home) => home.id === household.home_id);
    const ids = new Set(candidate.devices.map((device) => device.id));
    const device = Object.fromEntries(
      Object.entries(this.projection.device).filter(([, value]) =>
        ids.has(value.id),
      ),
    );
    const failure = homeLost
      ? this.source.failure(new HouseholdError("home_unavailable"))
      : null;
    this.actor.send({
      type: "revoke",
      scope_epoch: epoch,
      homeLost,
      projection: produce(this.projection, (draft) => {
        draft.device = homeLost ? {} : device;
        if (homeLost) {
          draft.home = {};
          draft.room = {};
          draft.household.household.sync_status = "error";
          draft.household.household.error = failure;
          draft.household.household.homes.status = "unavailable";
        }
      }),
    });
    assertCurrent();
    this.specs.retain(homeLost ? new Set() : ids);
  }
  private withSpecifications(
    devices: Projection["device"],
    deviceIds?: ReadonlySet<string>,
  ) {
    const { specs, references } = this.specs.snapshot(deviceIds);
    const account = this.projection.household.household.account_id ?? "";
    const keys = deviceIds
      ? [...deviceIds].map((id) => entityKey(account, id))
      : Object.keys(devices);
    const device = produce(devices, (draft) => {
      for (const key of keys) {
        const value = devices[key];
        if (!value) continue;
        const { spec_id, spec_status, spec_error } =
          references.get(value.id) ?? initialSpecification;
        const spec = spec_id ? specs[spec_id] : undefined;
        let summary = spec ? this.summaries.get(spec.spec) : undefined;
        if (spec && !summary) {
          const capabilities = Object.entries(spec.spec);
          const capability_tags = [
            ...(["readable", "writeable", "notify"] as const).filter((tag) =>
              capabilities.some(([, capability]) => capability[tag]),
            ),
            ...(["action", "event"] as const).filter((tag) =>
              capabilities.some(([id]) => id.startsWith(tag + ".")),
            ),
          ];
          summary = { category: spec.category, capability_tags };
          this.summaries.set(spec.spec, summary);
        }
        const category = summary?.category ?? null;
        const capability_tags = summary?.capability_tags ?? [];
        if (
          value.spec_id === spec_id &&
          value.spec_status === spec_status &&
          value.spec_error === spec_error &&
          value.category === category &&
          value.capability_tags.length === capability_tags.length &&
          value.capability_tags.every(
            (tag, index) => tag === capability_tags[index],
          )
        )
          continue;
        Object.assign(draft[key]!, {
          spec_id,
          spec_status,
          spec_error,
          category,
          capability_tags,
        });
      }
    });
    return { device };
  }
  private publishSpecifications(deviceIds?: ReadonlySet<string>) {
    if (this.stopped) return;
    this.publish({
      ...this.projection,
      ...this.withSpecifications(this.projection.device, deviceIds),
    });
  }
  private syncSource() {
    if (!this.stopped)
      this.actor.send({ type: "source", state: this.source.snapshot() });
  }
  private fail(epoch: string, error: unknown, stage: "account" | "directory") {
    if (epoch !== this.epoch || this.stopped) return;
    this.actor.send({
      type: "failure",
      scope_epoch: epoch,
      stage,
      error: this.source.failure(error, stage),
    });
  }
  specification(id: string) {
    const device =
      this.projection.device[
        entityKey(this.projection.household.household.account_id ?? "", id)
      ];
    if (!device) throw new HouseholdError("device_not_found");
    if (!this.specs.isApplicable(id, device.model))
      throw new HouseholdError("spec_unavailable");
    const spec = device.spec_id
      ? this.specs.snapshot(new Set([id])).specs[device.spec_id]
      : undefined;
    if (!spec) throw new HouseholdError("spec_unavailable");
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
      !this.projection.device[
        entityKey(this.projection.household.household.account_id ?? "", id)
      ]
    )
      throw new HouseholdError("devices_failed");
    return this.source.reservePlayback(revision, id, channel);
  }
  logout() {
    if (this.logoutTask) return this.logoutTask;
    this.assertEpoch(this.epoch);
    this.command({
      type: "command",
      scope_epoch: this.epoch,
      effect: { kind: "logout" },
    });
    if (!this.logoutTask) throw new HouseholdError("invalid_state");
    return this.logoutTask;
  }
  private async leave(operation_id: number) {
    try {
      await this.source.logout();
    } catch (error) {
      if (this.context.operation_id === operation_id)
        this.fail(this.epoch, error, "account");
      throw error;
    } finally {
      this.actor.send({ type: "finished", operation_id, operation: "logout" });
      this.syncSource();
      this.logoutTask = undefined;
    }
  }
  private resetResources() {
    this.refreshTasks.clear();
    this.specs.clear();
  }
  close() {
    if (this.closing) return this.closing;
    this.actor.send({ type: "stop" });
    this.resetResources();
    clearInterval(this.memoryTimer);
    this.unsubscribe?.();
    this.closing = Promise.resolve()
      .then(() => this.source.close())
      .then(() => {})
      .finally(() => {
        this.actor.stop();
        this.listeners.clear();
      });
    return this.closing;
  }
}
