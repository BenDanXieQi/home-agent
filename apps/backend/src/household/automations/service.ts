import { createAutomationExecution } from "./execution";
import { queryAutomationCapabilities, queryAutomations } from "./queries";
import { automationConditions, leaves, referencedFacts } from "./facts";
import PQueue from "p-queue";
import { z } from "zod";
import {
  automationPredicateSchema,
  automationSchema,
  type automationCapabilitiesQuerySchema,
  type automationListQuerySchema,
  evaluateAutomationTree,
  validateAutomationCapabilities,
  type AutomationDefinition,
  type AutomationEvent,
  type automationSaveRequestSchema,
} from "@home-agent/api/automations";
import { propertyKey } from "@home-agent/api/observations";
import { AppError } from "@home-agent/api/errors";
import type { Database } from "../../db";
import { automations } from "../../db/schema";
import type { HouseholdRuntime } from "../runtime";
import type { MijiaService } from "../../mijia/service";
import { accessHousehold } from "../access";
import { createAutomationActions } from "./actions";
import { createAutomationRepository } from "./repository";
import { advanceAutomation } from "./evaluation";
import type { automationInputSchema } from "./state";
import { readAutomationCapabilities } from "./capabilities";

type StoredAutomation = typeof automations.$inferSelect;

export function createAutomationService(deps: {
  db: Database;
  household: HouseholdRuntime;
  mijia: MijiaService;
  signal: AbortSignal;
  readEventTypes: () => string[];
}) {
  const repository = createAutomationRepository(deps.db);
  const writes = new PQueue({ concurrency: 1 });
  const feedbackWrites = new Set<Promise<void>>();
  const definitions = new Map<string, StoredAutomation>();
  const states = new Map<
    string,
    ReturnType<typeof advanceAutomation>["state"]
  >();
  const timers = new Map<
    string,
    { at: string; handle: ReturnType<typeof setTimeout> }
  >();
  const eventIndex = new Map<string, Set<string>>();
  const propertyIndex = new Map<string, Set<string>>();
  const invalidated = new Map<string, symbol>();
  const continuity = new Map<
    string,
    z.infer<typeof automationInputSchema>["episodes"][string] & {
      truth: boolean | null;
      sequence: number;
    }
  >();
  function episodes(
    automationId: string,
    definition: AutomationDefinition,
    values: ReturnType<typeof leaves>,
    sequence: number,
  ) {
    return Object.fromEntries(
      automationConditions(definition).map((condition) => {
        const key = JSON.stringify([
          automationId,
          condition.id,
          automationPredicateSchema.parse(condition.predicate),
        ]);
        const truth = values[condition.id]?.truth ?? null;
        let current = continuity.get(key);
        if (!current || current.truth !== truth) {
          const changed = {
            truth,
            id: crypto.randomUUID(),
            previous_id: current?.id ?? null,
            sequence,
          };
          if (!current || sequence >= current.sequence)
            continuity.set(key, changed);
          current = changed;
        } else if (sequence > current.sequence) current.sequence = sequence;
        return [
          condition.id,
          { id: current.id, previous_id: current.previous_id },
        ];
      }),
    );
  }
  const deviceIndex = new Map<string, Set<string>>();
  let epoch: string | null = null;
  let refreshing = false;
  let acceptingInputs = false;
  let refreshTask: Promise<void> | undefined;
  let stopped = false;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let cleanupTask: Promise<void> | undefined;
  const scope = () => accessHousehold(deps.household, deps.household.epoch);

  const capabilities = () =>
    readAutomationCapabilities(deps.household, deps.readEventTypes());
  function capture(
    row: StoredAutomation,
    kind: z.infer<typeof automationInputSchema>["kind"],
    snapshot = deps.household.snapshot(),
    event?: AutomationEvent,
    report: z.infer<typeof automationInputSchema>["report"] = null,
  ) {
    const now = new Date();
    const values = leaves(row.definition, snapshot, now, event);
    const input = {
      kind,
      scope_epoch: snapshot.scope_epoch,
      sequence: snapshot.sequence,
      at: now.toISOString(),
      report,
      facts: referencedFacts(row.definition, snapshot),
      leaves: values,
      episodes: episodes(row.id, row.definition, values, snapshot.sequence),
      ...(event ? { event } : {}),
    };
    return input;
  }
  function reindex() {
    propertyIndex.clear();
    deviceIndex.clear();
    eventIndex.clear();
    const used = new Set(
      [...definitions.values()].flatMap((row) =>
        automationConditions(row.definition).map((node) =>
          JSON.stringify([
            row.id,
            node.id,
            automationPredicateSchema.parse(node.predicate),
          ]),
        ),
      ),
    );
    for (const key of continuity.keys())
      if (!used.has(key)) continuity.delete(key);
    for (const row of definitions.values()) {
      if (!row.enabled) continue;
      for (const condition of automationConditions(row.definition)) {
        if (condition.predicate.kind === "event") {
          const type = condition.predicate.event_type;
          const rules = eventIndex.get(type) ?? new Set<string>();
          rules.add(row.id);
          eventIndex.set(type, rules);
        }
        const refs =
          condition.predicate.kind === "property"
            ? [condition.predicate]
            : condition.predicate.kind === "ai"
              ? condition.predicate.property_refs
              : [];
        for (const { device_id, property_key } of refs) {
          const [, siid, piid] = property_key.split(".");
          const key = propertyKey(
            deps.household.snapshot().projection.household.household
              .account_id ?? "",
            device_id,
            Number(siid),
            Number(piid),
          );
          const properties = propertyIndex.get(key) ?? new Set<string>();
          properties.add(row.id);
          propertyIndex.set(key, properties);
          const devices = deviceIndex.get(device_id) ?? new Set<string>();
          devices.add(row.id);
          deviceIndex.set(device_id, devices);
        }
      }
    }
  }
  function onFailure(error: unknown) {
    if (!stopped && !deps.signal.aborted)
      console.warn(
        "自动化操作失败，本次工作已丢弃",
        error instanceof AppError ? error.code : "storage_or_scope_unavailable",
      );
  }
  function write<T>(task: () => Promise<T>) {
    if (stopped || writes.size + writes.pending >= 256)
      return Promise.reject(new AppError("household_storage_unavailable"));
    return writes.add(task);
  }
  function revoke(id: string) {
    const operation = Symbol();
    invalidated.set(id, operation);
    clearRuleState(id);
    return operation;
  }
  function clearRuleState(id: string) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer.handle);
    timers.delete(id);
    states.delete(id);
  }
  function clearRuntime() {
    for (const id of states.keys()) clearRuleState(id);
    continuity.clear();
  }
  function scheduleRuleTimer(row: StoredAutomation, at: string | null) {
    const previous = timers.get(row.id);
    if (at && previous?.at === at) return;
    if (previous) clearTimeout(previous.handle);
    timers.delete(row.id);
    if (!at || stopped) return;
    const handle = setTimeout(
      () => {
        timers.delete(row.id);
        if (
          !acceptingInputs ||
          !deps.household.ready ||
          definitions.get(row.id)?.revision !== row.revision
        )
          return;
        processInput(row, "timer");
      },
      Math.max(0, Date.parse(at) - Date.now()),
    );
    handle.unref();
    timers.set(row.id, { at, handle });
  }
  function processInput(
    row: StoredAutomation,
    kind: z.infer<typeof automationInputSchema>["kind"],
    snapshot = deps.household.snapshot(),
    event?: AutomationEvent,
    report: z.infer<typeof automationInputSchema>["report"] = null,
  ) {
    if (
      stopped ||
      invalidated.has(row.id) ||
      !row.enabled ||
      row.definition.decision !== undefined ||
      automationConditions(row.definition).some(
        (node) => node.predicate.kind === "ai",
      ) ||
      definitions.get(row.id)?.revision !== row.revision ||
      snapshot.scope_epoch !== epoch
    )
      return;
    try {
      const input = capture(row, kind, snapshot, event, report);
      const startedAt = new Date().toISOString();
      const started = performance.now();
      // No await here: each input observes the state left by the previous input.
      const result = advanceAutomation(
        row.definition,
        row.revision,
        input,
        states.get(row.id) ?? null,
      );
      const durationMs = performance.now() - started;
      const finishedAt = new Date().toISOString();
      states.set(row.id, result.state);
      scheduleRuleTimer(row, result.state.next_at);
      if (!result.execute) return;
      const current = scope();
      const timing = {
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: durationMs,
      };
      actions.schedule(
        current,
        createAutomationExecution(row, input, result.evaluation, timing),
      );
    } catch (error) {
      onFailure(error);
    }
  }
  function pruneHistory() {
    if (stopped || !deps.household.ready || cleanupTask) return;
    const task = repository.pruneHistory(scope());
    cleanupTask = task;
    task.catch(onFailure).finally(() => {
      cleanupTask = undefined;
    });
  }
  async function refresh() {
    if (!deps.household.ready || stopped) return;
    const current = scope();
    const reset = epoch !== current.snapshot.scope_epoch;
    // Drain execution writes before rebuilding a household's in-memory baseline.
    acceptingInputs = false;
    await writes.onIdle();
    current.assertCurrent();
    const rows = await repository.list(current);
    current.assertCurrent();
    if (reset) await repository.discardPending(current);
    current.assertCurrent();
    const old = new Map(definitions);
    if (reset) clearRuntime();
    definitions.clear();
    for (const row of rows) definitions.set(row.id, row);
    reindex();
    epoch = current.snapshot.scope_epoch;
    current.assertCurrent();
    const snapshot = deps.household.snapshot();
    for (const row of rows) {
      if (
        row.enabled &&
        (reset || old.get(row.id)?.revision !== row.revision)
      ) {
        clearRuleState(row.id);
        processInput(row, "baseline", snapshot);
      }
    }
    acceptingInputs = true;
    current.assertCurrent();
  }
  function requestRefresh() {
    if (
      refreshing ||
      stopped ||
      !deps.household.ready ||
      epoch === deps.household.epoch
    )
      return;
    refreshing = true;
    const requestedEpoch = deps.household.epoch;
    const task = refresh();
    refreshTask = task;
    task.catch(onFailure).finally(() => {
      refreshTask = undefined;
      refreshing = false;
      if (deps.household.epoch !== requestedEpoch) requestRefresh();
    });
  }
  const unsubscribe = deps.household.subscribe(() => {
    if (!deps.household.ready || epoch !== deps.household.epoch) {
      acceptingInputs = false;
      definitions.clear();
      clearRuntime();
      reindex();
      epoch = null;
    }
    requestRefresh();
  });
  const unsubscribeFacts = deps.household.subscribeFacts((commit) => {
    if (
      stopped ||
      !acceptingInputs ||
      !deps.household.ready ||
      epoch !== commit.state_version.scope_epoch
    )
      return;
    const snapshot = deps.household.snapshot();
    const observation = commit.result?.observation;
    const event = observation?.event;
    const reported =
      event?.kind === "property" && event.delivery_kind === "live"
        ? snapshot.projection.latest[
            propertyKey(
              snapshot.projection.household.household.account_id ?? "",
              event.did,
              event.siid,
              event.piid,
            )
          ]
        : undefined;
    const report =
      reported &&
      commit.result?.receipt.outcome === "applied" &&
      reported.evidence?.observation_id === observation?.observation_id
        ? {
            device_id: reported.device_id,
            property_key: `prop.${reported.siid}.${reported.piid}`,
          }
        : null;
    const ids = new Set<string>();
    for (const change of commit.changes) {
      if (change.entity === "latest")
        for (const id of propertyIndex.get(change.key) ?? []) ids.add(id);
      if (change.entity === "device") {
        const device = snapshot.projection.device[change.key];
        if (device)
          for (const id of deviceIndex.get(device.id) ?? []) ids.add(id);
        else
          for (const row of definitions.values())
            if (row.enabled) ids.add(row.id);
      }
      if (change.entity === "source_health")
        for (const row of definitions.values())
          if (row.enabled) ids.add(row.id);
    }
    const current = scope();
    if (
      report &&
      reported &&
      [...definitions.values()].some((row) =>
        row.definition.actions.some(
          (action) =>
            action.kind === "set_property" &&
            action.device_id === report.device_id &&
            action.property_key === report.property_key,
        ),
      )
    ) {
      if (feedbackWrites.size < 64) {
        const task = actions.observeReport(current, reported);
        feedbackWrites.add(task);
        task
          .catch((error: unknown) => {
            console.warn(
              "自动化设备反馈时间未保存",
              error instanceof Error ? error.name : "unknown",
            );
          })
          .finally(() => {
            feedbackWrites.delete(task);
          });
      } else console.warn("自动化设备反馈记录繁忙，本次反馈未保存");
    }
    for (const id of ids) {
      const row = definitions.get(id);
      if (!row) continue;
      processInput(row, "facts", snapshot, undefined, report);
    }
  });
  const actionDependencies = {
    db: deps.db,
    mijia: deps.mijia,
    signal: deps.signal,
    snapshot: () => deps.household.snapshot(),
    isCurrent: (id, revision) =>
      !refreshing &&
      !stopped &&
      !invalidated.has(id) &&
      definitions.get(id)?.revision === revision &&
      definitions.get(id)?.enabled === true,
    eligible: (automationId, definition, input, evaluation) => {
      if (validateAutomationCapabilities(definition, capabilities()).length > 0)
        return false;
      const snapshot = deps.household.snapshot();
      const values = leaves(definition, snapshot, new Date(), input.event);
      const currentEpisodes = episodes(
        automationId,
        definition,
        values,
        snapshot.sequence,
      );
      const continuousIds = new Set(
        automationConditions(definition)
          .filter((node) => node.predicate.kind !== "event")
          .map((node) => node.id),
      );
      if (
        evaluation.triggered_by.some(
          (id) =>
            continuousIds.has(id) &&
            input.episodes[id]?.id !== currentEpisodes[id]?.id,
        )
      )
        return false;
      return evaluateAutomationTree(
        definition.tree,
        values,
        new Set(evaluation.triggered_by),
      ).eligible;
    },
  } satisfies Parameters<typeof createAutomationActions>[0];
  const actions = createAutomationActions(actionDependencies);
  function describe(row: StoredAutomation, available = capabilities()) {
    const reasons = validateAutomationCapabilities(row.definition, available);
    const evaluation = evaluateAutomationTree(
      row.definition.tree,
      leaves(row.definition, deps.household.snapshot(), new Date(), undefined),
    );
    if (evaluation.truth === null)
      reasons.push("部分条件缺值、离线、过期或无效；可检查节点原因");
    if (!acceptingInputs || invalidated.has(row.id))
      reasons.push("规则已暂停；配置保存失败时请刷新后重新保存");
    return automationSchema.parse({
      id: row.id,
      revision: row.revision,
      enabled: row.enabled,
      definition: row.definition,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      readiness: !row.enabled
        ? "disabled"
        : reasons.length
          ? "unavailable"
          : "ready",
      reasons,
    });
  }
  return {
    async start() {
      // Establish current conditions before accepting rule triggers.
      requestRefresh();
      await refreshTask?.catch(onFailure);
      cleanupTimer = setInterval(() => {
        requestRefresh();
        pruneHistory();
      }, 60_000);
      cleanupTimer.unref();
      pruneHistory();
    },
    async list(scopeEpoch: string) {
      const current = accessHousehold(deps.household, scopeEpoch);
      const rows = await repository.list(current);
      current.assertCurrent();
      const available = capabilities();
      return { automations: rows.map((row) => describe(row, available)) };
    },
    capabilities(scopeEpoch: string) {
      accessHousehold(deps.household, scopeEpoch);
      return capabilities();
    },
    queryCapabilities(
      input: z.infer<typeof automationCapabilitiesQuerySchema>,
    ) {
      accessHousehold(deps.household, input.scope_epoch);
      return queryAutomationCapabilities(input, capabilities());
    },
    async query(input: z.infer<typeof automationListQuerySchema>) {
      const current = accessHousehold(deps.household, input.scope_epoch);
      const rows = await repository.list(current);
      current.assertCurrent();
      return queryAutomations(input, rows);
    },
    async read(scopeEpoch: string, id: string) {
      const current = accessHousehold(deps.household, scopeEpoch);
      const row = await repository.get(current, id);
      current.assertCurrent();
      if (!row)
        throw new AppError("invalid_request", {
          params: { reason: "自动化不存在" },
        });
      return describe(row);
    },
    async save(input: z.infer<typeof automationSaveRequestSchema>) {
      const current = accessHousehold(deps.household, input.scope_epoch);
      const problems = validateAutomationCapabilities(
        input.definition,
        capabilities(),
      );
      if (input.enabled && problems.length)
        throw new AppError("invalid_request", {
          params: { reason: problems.join("；") },
        });
      const operation = revoke(input.id);
      await refreshTask;
      const saved = await write(async () => {
        const row = await repository.save(current, input);
        current.assertCurrent();
        definitions.set(row.id, row);
        reindex();
        // A failed write stays paused. Only the latest confirmed save restores it.
        if (invalidated.get(row.id) === operation) {
          invalidated.delete(row.id);
          clearRuleState(row.id);
          if (row.enabled) processInput(row, "baseline");
        }
        return row;
      });
      if (!saved) throw new AppError("household_storage_unavailable");
      current.assertCurrent();
      return describe(saved);
    },
    async remove(scopeEpoch: string, id: string, revision: number) {
      const current = accessHousehold(deps.household, scopeEpoch);
      const operation = revoke(id);
      await refreshTask;
      await write(async () => {
        await repository.remove(current, id, revision);
        current.assertCurrent();
        definitions.delete(id);
        reindex();
        if (invalidated.get(id) === operation) invalidated.delete(id);
      });
    },
    evaluate(scopeEpoch: string, definition: AutomationDefinition) {
      const current = accessHousehold(deps.household, scopeEpoch);
      return evaluateAutomationTree(
        definition.tree,
        leaves(definition, current.snapshot, new Date()),
      );
    },
    async runs(scopeEpoch: string, id: string | undefined, limit: number) {
      const current = accessHousehold(deps.household, scopeEpoch);
      const runs = await repository.runs(current, id, limit);
      current.assertCurrent();
      return { runs };
    },
    acceptEvent(event: AutomationEvent) {
      if (stopped || !acceptingInputs || !deps.household.ready) return;
      const snapshot = deps.household.snapshot();
      if (snapshot.scope_epoch !== epoch) return;
      for (const id of eventIndex.get(event.event_type) ?? []) {
        const row = definitions.get(id);
        if (
          !row ||
          !automationConditions(row.definition).some(
            ({ predicate }) =>
              predicate.kind === "event" &&
              predicate.event_type === event.event_type &&
              (!predicate.device_id || predicate.device_id === event.device_id),
          )
        )
          continue;
        processInput(row, "event", snapshot, event);
      }
    },
    async close() {
      stopped = true;
      clearRuntime();
      clearInterval(cleanupTimer);
      unsubscribe();
      unsubscribeFacts();
      await refreshTask?.catch(onFailure);
      await writes.onIdle();
      await actions.close();
      await Promise.allSettled([
        ...feedbackWrites,
        ...(cleanupTask ? [cleanupTask] : []),
      ]);
    },
  };
}
export type AutomationService = ReturnType<typeof createAutomationService>;
