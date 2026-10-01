import { freeze } from "@home-agent/api/immutable";
import {
  deviceSchema,
  entityKey,
  selectRoomFacts,
} from "@home-agent/api/household";
import {
  latestPropertySchema,
  propertyKey,
} from "@home-agent/api/observations";
import {
  analysisChangeSchema,
  analysisResponseSchema,
  roomAnalysisLimits,
  roomAnalysisStateSchema,
  validateInterpretation,
  type analysisRequestSchema,
  type roomAnalysisQuerySchema,
} from "@home-agent/api/room-analysis";
import type { z } from "zod";
import { HouseholdError } from "../household/errors";
import type { HouseholdRuntime } from "../household/runtime";
import {
  buildRoomContext,
  canTrigger,
  contextExpired,
  jsonBytes,
  meaningfulChange,
  roomDependencies,
  roomDependenciesChanged,
  factMetadata,
  factMeaning,
  relevantProperty,
} from "./context";

function roomEntry(scope: string, room: string | null) {
  return {
    state: roomAnalysisStateSchema.parse({
      scope_epoch: scope,
      room_id: room,
      status: "idle",
      message: null,
      updated_at: new Date().toISOString(),
      pending_changes: 0,
      automatic_properties: 0,
      attempts: 0,
      accepted: 0,
      rejected: 0,
      latest: null,
      attempt: null,
    }),
    dependencies: null as ReturnType<typeof roomDependencies> | null,
    runningDependencies: null as ReturnType<typeof roomDependencies> | null,
    invalidated: false,
    pending: [] as z.infer<typeof analysisChangeSchema>[],
    truncated: false,
    manual: false,
    queuedAt: 0,
    dueAt: 0,
    lastStarted: 0,
    controller: null as AbortController | null,
  };
}

/** Owns interpretation tasks only; device facts remain owned by HouseholdRuntime. */
export class RoomAnalysisService {
  private readonly rooms = new Map<
    string | null,
    ReturnType<typeof roomEntry>
  >();
  private readonly baselines = new Map<
    string,
    z.infer<typeof latestPropertySchema>["value"]
  >();
  private epoch: string;
  private readonly dirty = new Set<string | null>();
  private readonly listeners = new Set<() => void>();
  private running = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduled = false;
  private closed = false;
  private readonly unsubscribe;
  private readonly unsubscribeFacts;

  constructor(
    private readonly household: HouseholdRuntime,
    private readonly analyze: (
      input: z.infer<typeof analysisRequestSchema>,
      signal: AbortSignal,
    ) => Promise<z.infer<typeof analysisResponseSchema>>,
  ) {
    this.epoch = household.epoch;
    this.unsubscribe = household.subscribe(() => {
      if (this.epoch !== household.epoch || !household.ready) this.reset();
    });
    this.unsubscribeFacts = household.subscribeFacts((commit) => {
      if (
        this.closed ||
        !household.ready ||
        commit.state_version.scope_epoch !== this.epoch
      )
        return;
      // Invalidation and task admission never wait for the model.
      for (const change of commit.transitions) {
        if (change.entity === "latest") {
          const previous = latestPropertySchema.safeParse(change.before);
          if (
            change.op === "remove" ||
            !canTrigger(change.value) ||
            (previous.success &&
              factMetadata(previous.data) !== factMetadata(change.value))
          ) {
            this.baselines.delete(change.key);
            if (previous.success) {
              const fact = previous.data;
              const entry = this.rooms.get(fact.room_id);
              if (entry) {
                const pending = entry.pending.filter(
                  (item) =>
                    item.device_id !== fact.device_id ||
                    item.siid !== fact.siid ||
                    item.piid !== fact.piid,
                );
                if (pending.length !== entry.pending.length) {
                  entry.pending = pending;
                  entry.truncated = true;
                  this.dirty.add(fact.room_id);
                }
              }
            }
          }
          if (
            change.op === "upsert" &&
            previous.success &&
            factMeaning(previous.data) === factMeaning(change.value)
          )
            continue;
          if (previous.success && relevantProperty(previous.data))
            this.dirty.add(previous.data.room_id);
          if (change.op === "upsert" && relevantProperty(change.value))
            this.dirty.add(change.value.room_id);
        } else if (change.entity === "device") {
          const previous = deviceSchema.safeParse(change.before);
          if (previous.success) this.dirty.add(previous.data.room_id ?? null);
          if (change.op === "upsert")
            this.dirty.add(change.value.room_id ?? null);
        } else if (change.entity === "room") {
          for (const room of this.rooms.keys()) this.dirty.add(room);
        }
      }
      for (const edge of commit.result?.edges ?? []) {
        const fact = edge.after;
        if (
          !canTrigger(edge.before) ||
          !canTrigger(fact) ||
          factMetadata(edge.before) !== factMetadata(fact)
        )
          continue;
        const baseline = this.baselines.has(edge.key)
          ? this.baselines.get(edge.key)!
          : edge.before.value;
        if (!this.baselines.has(edge.key))
          this.baselines.set(edge.key, baseline);
        if (!meaningfulChange(baseline, fact)) continue;
        this.baselines.set(edge.key, fact.value);
        const entry = this.ensure(fact.room_id, false);
        if (!entry) continue;
        const device =
          household.snapshot().projection.device[
            entityKey(fact.account_id, fact.device_id)
          ];
        const parsed = analysisChangeSchema.safeParse({
          id: crypto.randomUUID(),
          device_id: fact.device_id,
          device: (device?.alias ?? device?.name ?? fact.device_id).slice(
            0,
            256,
          ),
          siid: fact.siid,
          piid: fact.piid,
          property: fact.description.slice(0, 256),
          before: edge.before.value,
          after: fact.value,
          at: fact.evidence!.received_at,
          observation_id: fact.evidence!.observation_id,
        });
        if (!parsed.success) continue;
        while (
          entry.pending.length >= roomAnalysisLimits.changes ||
          this.queuedBytes() + jsonBytes(parsed.data) >
            roomAnalysisLimits.queueBytes
        ) {
          entry.truncated = true;
          entry.state.message =
            "变化较密集，部分变化已裁减；分析会重新读取当前房间。";
          if (entry.pending.length) entry.pending.shift();
          else break;
        }
        if (
          this.queuedBytes() + jsonBytes(parsed.data) + 1 >
          roomAnalysisLimits.queueBytes
        )
          continue;
        entry.pending.push(parsed.data);
        this.queue(entry, false);
        this.dirty.add(fact.room_id);
      }
      // Observe each commit before a recovery can hide an intervening invalidation.
      for (const room of this.dirty) {
        const entry = this.rooms.get(room);
        if (!entry) continue;
        this.reconcile(entry);
        if (
          entry.runningDependencies &&
          !entry.invalidated &&
          roomDependenciesChanged(
            entry.runningDependencies,
            roomDependencies(household.snapshot(), room),
          )
        )
          entry.invalidated = true;
      }
      if (this.dirty.size) this.schedule();
    });
  }

  private ensure(room: string | null, required: boolean) {
    let entry = this.rooms.get(room);
    if (!entry && this.rooms.size < roomAnalysisLimits.rooms) {
      entry = roomEntry(this.epoch, room);
      this.rooms.set(room, entry);
    }
    if (!entry && required) throw new HouseholdError("capacity_exceeded");
    return entry;
  }
  private assertScope(input: z.infer<typeof roomAnalysisQuerySchema>) {
    if (this.closed || !this.household.ready)
      throw new HouseholdError("invalid_state");
    if (input.scope_epoch !== this.household.epoch)
      throw new HouseholdError("stale_session");
    const home = this.household.snapshot().projection;
    if (
      input.room_id !== null &&
      !Object.values(home.room).some(
        (room) => room.room_id === input.room_id && !room.archived,
      )
    )
      throw new HouseholdError("invalid_state");
  }
  snapshot(input: z.infer<typeof roomAnalysisQuerySchema>) {
    this.assertScope(input);
    const entry = this.ensure(input.room_id, true)!;
    this.reconcile(entry);
    const view = selectRoomFacts(this.household.snapshot(), {
      room_id: input.room_id,
      limit: 2000,
    });
    return freeze(
      roomAnalysisStateSchema.parse({
        ...entry.state,
        pending_changes: entry.pending.length,
        automatic_properties: view.properties.filter(canTrigger).length,
      }),
    );
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A viewer cannot interrupt analysis. */
      }
    }
  }
  request(input: z.infer<typeof roomAnalysisQuerySchema>) {
    this.assertScope(input);
    const entry = this.ensure(input.room_id, true)!;
    if (!entry.controller && !entry.manual) {
      entry.manual = true;
      this.queue(entry, true);
      this.schedule();
    }
    return this.snapshot(input);
  }
  private queue(entry: ReturnType<typeof roomEntry>, manual: boolean) {
    const now = Date.now();
    entry.queuedAt ||= now;
    entry.dueAt = Math.max(
      Math.min(
        now + (manual ? 0 : roomAnalysisLimits.mergeMs),
        entry.queuedAt + roomAnalysisLimits.maxWaitMs,
      ),
      entry.lastStarted + roomAnalysisLimits.cooldownMs,
    );
    if (!entry.controller) entry.state.status = "queued";
    entry.state.updated_at = new Date().toISOString();
  }
  private queuedBytes() {
    return [...this.rooms.values()].reduce(
      (sum, entry) => sum + jsonBytes(entry.pending),
      0,
    );
  }
  private reconcile(
    entry: ReturnType<typeof roomEntry>,
    checkDependencies = true,
  ) {
    const latest = entry.state.latest;
    if (!latest || latest.stale_reason) return;
    const reason = contextExpired(latest.context)
      ? "总结依据已到期，请以最新设备状态为准。"
      : checkDependencies &&
          roomDependenciesChanged(
            entry.dependencies,
            roomDependencies(this.household.snapshot(), entry.state.room_id),
          )
        ? "相关状态发生重要变化或证据有效性改变，这份总结已过期。"
        : null;
    if (reason) {
      latest.stale_reason = reason;
      if (entry.state.status === "ready") entry.state.status = "stale";
      entry.state.updated_at = new Date().toISOString();
    }
  }
  private schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.closed) this.pump();
    });
  }
  private pump() {
    clearTimeout(this.timer);
    let next = Infinity;
    const now = Date.now();
    const activeRooms = new Set(
      Object.values(this.household.snapshot().projection.room)
        .filter((room) => !room.archived)
        .map((room) => room.room_id),
    );
    const entries = [...this.rooms].toSorted(
      (a, b) => a[1].queuedAt - b[1].queuedAt,
    );
    for (const [roomId, entry] of entries) {
      if (roomId !== null && !activeRooms.has(roomId)) {
        entry.controller?.abort();
        this.rooms.delete(roomId);
        continue;
      }
      this.reconcile(entry, this.dirty.has(roomId));
      if (entry.queuedAt && !entry.controller) {
        if (entry.dueAt <= now && this.running < roomAnalysisLimits.concurrent)
          this.run(entry).catch((error: unknown) => {
            console.error("Room analysis task failed", error);
          });
        else if (entry.dueAt > now) next = Math.min(next, entry.dueAt);
      }
      const latest = entry.state.latest;
      if (latest && !latest.stale_reason) {
        next = Math.min(
          next,
          Date.parse(latest.context.captured_at) + roomAnalysisLimits.maxAgeMs,
        );
      }
    }
    this.dirty.clear();
    this.notify();
    if (Number.isFinite(next)) {
      this.timer = setTimeout(
        () => this.schedule(),
        Math.max(1, next - Date.now()),
      );
      this.timer.unref();
    }
  }
  private async run(entry: ReturnType<typeof roomEntry>) {
    const manual = entry.manual;
    const room = entry.state.room_id;
    const snapshot = this.household.snapshot();
    const view = selectRoomFacts(snapshot, { room_id: room, limit: 2000 });
    const eligible = new Set(
      view.properties
        .filter(canTrigger)
        .map((fact) =>
          propertyKey(fact.account_id, fact.device_id, fact.siid, fact.piid),
        ),
    );
    const account = view.account_id ?? "";
    const changes = entry.pending.filter(
      (change) =>
        Date.now() - Date.parse(change.at) <= roomAnalysisLimits.changeAgeMs &&
        eligible.has(
          propertyKey(account, change.device_id, change.siid, change.piid),
        ),
    );
    const dropped = entry.truncated || changes.length !== entry.pending.length;
    entry.pending = [];
    entry.manual = false;
    entry.queuedAt = 0;
    entry.truncated = false;
    if (!manual && !changes.length) {
      entry.state.status = entry.state.latest ? "stale" : "idle";
      entry.state.message = "候选变化已过期或依据失效，本次未调用 AI。";
      return;
    }
    const context = buildRoomContext(
      snapshot,
      room,
      manual ? "manual" : "changes",
      changes,
      dropped,
      (did, siid, piid, value) => {
        try {
          const property =
            this.household.specification(did).spec[`prop.${siid}.${piid}`];
          const label = property?.value_list?.find(
            (item) => item.value === value,
          );
          return label?.description || label?.name || null;
        } catch {
          return null;
        }
      },
    );
    entry.state.attempt = { run_id: crypto.randomUUID(), context };
    if (!context.facts.length) {
      entry.state.status = "unavailable";
      entry.state.message = "这个房间还没有可解读的相关属性值，本次未调用 AI。";
      return;
    }
    const dependencies = roomDependencies(snapshot, room);
    const request = entry.state.attempt;
    const controller = new AbortController();
    entry.controller = controller;
    entry.runningDependencies = dependencies;
    entry.invalidated = false;
    entry.lastStarted = Date.now();
    entry.state.status = "running";
    entry.state.message = null;
    entry.state.attempts++;
    entry.state.updated_at = new Date().toISOString();
    this.running++;
    try {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(roomAnalysisLimits.timeoutMs),
      ]);
      const response = analysisResponseSchema.parse(
        await this.analyze(request, signal),
      );
      signal.throwIfAborted();
      if (
        this.rooms.get(room) !== entry ||
        this.epoch !== context.scope_epoch ||
        !this.household.ready
      )
        return;
      if (
        response.run_id !== request.run_id ||
        !validateInterpretation(context, response.interpretation)
      )
        throw new Error("AI 总结未通过观测描述或证据校验，结果未展示。");
      if (
        entry.invalidated ||
        contextExpired(context) ||
        roomDependenciesChanged(
          dependencies,
          roomDependencies(this.household.snapshot(), room),
        )
      ) {
        entry.state.rejected++;
        entry.state.status = "stale";
        entry.state.message =
          "分析期间相关状态发生重要变化或依据失效，返回结果未采纳。";
      } else {
        entry.dependencies = dependencies;
        entry.state.latest = {
          ...response,
          context,
          completed_at: new Date().toISOString(),
          stale_reason: null,
        };
        entry.state.attempt = null;
        entry.state.accepted++;
        entry.state.status = "ready";
      }
    } catch (error) {
      if (controller.signal.aborted || this.rooms.get(room) !== entry) return;
      entry.state.status = "error";
      entry.state.message =
        error instanceof Error
          ? error.message.slice(0, 512)
          : "房间分析未完成，请稍后重试。";
    } finally {
      entry.controller = null;
      entry.runningDependencies = null;
      this.running--;
      entry.state.updated_at = new Date().toISOString();
      if (entry.queuedAt) entry.state.status = "queued";
      this.schedule();
    }
  }
  private reset() {
    clearTimeout(this.timer);
    for (const entry of this.rooms.values()) entry.controller?.abort();
    this.rooms.clear();
    this.baselines.clear();
    this.dirty.clear();
    this.epoch = this.household.epoch;
    this.notify();
  }
  close() {
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeFacts();
    this.reset();
  }
}
