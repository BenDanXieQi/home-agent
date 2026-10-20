import type { speakerSchema } from "../protocols/micloud/mico";
import { createMaterialEventSubscriptions } from "./events";
import { accessMaterialDevice } from "./access";
import { createMaterialStorage } from "./storage";
import PQueue from "p-queue";
import { type deviceHistoryCollectionSchema } from "@home-agent/api/action-provenance";
import { MiCloudError } from "../protocols/micloud/errors";
import { MijiaError } from "../errors";
import { collectSpeakerConversations } from "./conversations";
import type { MijiaService } from "../service";
import type { HouseholdRuntime } from "../../household/runtime";
import { accessHousehold } from "../../household/access";
import type { createRecordWriter } from "../../household/records/writer";
import type { createMaterialRepository } from "../../household/materials/repository";
import type { materialCollectionConfigSchema } from "./config";
import type { recordRetentionConfigSchema } from "../../household/records/config";

type Scope = ReturnType<typeof accessHousehold>;
import {
  failure,
  success,
  type CollectorDiagnostic as Diagnostic,
} from "./diagnostics";
export function createMijiaMaterials(deps: {
  mijia: MijiaService;
  household: HouseholdRuntime;
  repository: ReturnType<typeof createMaterialRepository>;
  config: ReturnType<typeof materialCollectionConfigSchema.parse>;
  retention: ReturnType<typeof recordRetentionConfigSchema.parse>;
  writer: ReturnType<typeof createRecordWriter>;
  signal: AbortSignal;
}) {
  const requests = new PQueue({ concurrency: 2 });

  const states = new Map<string, Diagnostic>();
  const diagnosticDevices = new Map<string, string>();
  const gates = new Map<
    string,
    { next: number; failures: number; stopped: boolean }
  >();
  const active = new Set<string>();
  let closed = false;
  let scopeEpoch: string | undefined;
  let scopeReady = false;
  let deviceProjection:
    | ReturnType<HouseholdRuntime["snapshot"]>["projection"]["device"]
    | undefined;
  let sourceRevision: string | undefined;
  let sourceGeneration = 0;
  let retryAfterAt = 0;
  let ticking: Promise<void> | undefined;
  let speakers: ReturnType<typeof speakerSchema.parse>[] = [];
  const controller = new AbortController();
  const signal = AbortSignal.any([deps.signal, controller.signal]);
  const save = createMaterialStorage({ ...deps, signal });
  const eventSubscriptions = createMaterialEventSubscriptions({
    mijia: deps.mijia,
    signal,
    state,
    save,
  });
  function state(collector: string, scope: string, deviceId?: string) {
    const key = JSON.stringify([collector, scope]);
    if (deviceId) diagnosticDevices.set(key, deviceId);
    let value = states.get(key);
    if (!value) {
      value = {
        collector,
        scope,
        status: "not_attempted",
        query: null,
        retry_after_at: null,
        suspended: false,
        records_received: 0,
        records_saved: 0,
        records_repeated: 0,
        last_attempt_at: null,
        last_success_at: null,
        error: null,
        limitations: ["history_completeness_not_guaranteed"],
      };
      states.set(key, value);
    }
    return value;
  }
  function removeState(key: string) {
    states.delete(key);
    gates.delete(key);
    diagnosticDevices.delete(key);
  }
  function clearSources() {
    sourceGeneration++;
    sourceRevision = undefined;
    deviceProjection = undefined;
    speakers = [];
    states.clear();
    gates.clear();
    diagnosticDevices.clear();
    eventSubscriptions.clear();
  }
  function reconcileDevices(valid: ReadonlySet<string>) {
    for (const [key, did] of diagnosticDevices)
      if (!valid.has(did)) removeState(key);
    eventSubscriptions.reconcile(valid);
  }
  function synchronizeScope() {
    if (closed) return;
    const snapshot = deps.household.snapshot();
    if (
      scopeEpoch !== snapshot.scope_epoch ||
      scopeReady !== deps.household.ready
    ) {
      clearSources();
      scopeEpoch = snapshot.scope_epoch;
      scopeReady = deps.household.ready;
    }
    if (!scopeReady) {
      const account = snapshot.projection.account.account;
      const diagnostic = state("sources", "current_household");
      diagnostic.status =
        account.status === "idle" || account.status === "reauth_required"
          ? "missing_credentials"
          : "not_attempted";
      diagnostic.error = null;
      diagnostic.limitations = ["household_not_ready"];
      return;
    }
    if (deviceProjection === snapshot.projection.device) return;
    deviceProjection = snapshot.projection.device;
    reconcileDevices(
      new Set(
        Object.values(deviceProjection)
          .filter((device) => !device.archived)
          .map((device) => device.device_id),
      ),
    );
  }

  async function run(
    collector: string,
    owner: string,
    operation: (diagnostic: Diagnostic) => Promise<void>,
    periodic = true,
    query: Diagnostic["query"] = null,
  ) {
    const key = JSON.stringify([collector, owner]);
    const generation = sourceGeneration;
    const activeKey = JSON.stringify([generation, collector, owner]);
    const diagnostic = state(collector, owner);
    const gate = gates.get(key);
    const isCurrent = () =>
      !closed &&
      !signal.aborted &&
      deps.household.ready &&
      generation === sourceGeneration &&
      states.get(key) === diagnostic;
    if (!isCurrent()) throw new MijiaError("stale_session");
    if (active.has(activeKey)) {
      if (!periodic) throw new MijiaError("collection_busy");
      return structuredClone(diagnostic);
    }
    if (gate?.stopped || (gate && gate.next > Date.now()))
      return structuredClone(diagnostic);
    if (requests.size + requests.pending >= 64)
      throw new MijiaError("capacity_exceeded");
    diagnostic.query = query;
    active.add(activeKey);
    try {
      await requests.add(async () => {
        signal.throwIfAborted();
        if (!isCurrent()) throw new MijiaError("stale_session");
        if (retryAfterAt > Date.now())
          throw new MiCloudError("network", { retryAfterAt });
        diagnostic.suspended = false;
        diagnostic.retry_after_at = null;
        diagnostic.status = "running";
        diagnostic.records_received = 0;
        diagnostic.records_saved = 0;
        diagnostic.records_repeated = 0;
        diagnostic.last_attempt_at = new Date().toISOString();
        diagnostic.error = null;
        await operation(diagnostic);
        if (!isCurrent()) throw new MijiaError("stale_session");
        gates.set(key, {
          next: periodic ? Date.now() + deps.config.poll_interval_ms : 0,
          failures: 0,
          stopped: diagnostic.suspended,
        });
      });
    } catch (error) {
      if (!isCurrent()) {
        if (!periodic) throw new MijiaError("stale_session");
        return structuredClone(diagnostic);
      }
      if (error instanceof MiCloudError && error.retryAfterAt)
        retryAfterAt = Math.max(retryAfterAt, error.retryAfterAt);
      diagnostic.retry_after_at =
        retryAfterAt > Date.now() ? new Date(retryAfterAt).toISOString() : null;
      failure(diagnostic, error);
      const failures = (gate?.failures ?? 0) + 1;
      gates.set(key, {
        next: Math.max(
          Date.now() +
            Math.min(
              3600_000,
              deps.config.poll_interval_ms * 2 ** Math.min(6, failures),
            ),
          error instanceof MiCloudError ? (error.retryAfterAt ?? 0) : 0,
        ),
        failures,
        stopped: false,
      });
    } finally {
      active.delete(activeKey);
    }
    return structuredClone(diagnostic);
  }
  async function collectConversations(scope: Scope) {
    const session = deps.mijia.materialSession(signal);
    const authentication = await run(
      "mico_auth",
      "current",
      async (diagnostic) => {
        const discovered = await session.client.mico().devices(session.signal);
        session.assertCurrent();
        scope.assertCurrent();
        speakers = discovered;
        const devices = new Set(session.devices().map((device) => device.did));
        const speakerIds = new Set(
          speakers
            .filter((speaker) => devices.has(speaker.miotDID))
            .map((speaker) => speaker.deviceID),
        );
        for (const [key, previous] of states)
          if (
            previous.collector === "xiaoai_conversation" &&
            !speakerIds.has(previous.scope)
          )
            removeState(key);
        success(diagnostic, speakers.length);
      },
    );
    if (authentication.status !== "ready" && authentication.status !== "empty")
      return;
    for (const speaker of speakers) {
      const device = session
        .devices()
        .find((candidate) => candidate.did === speaker.miotDID);
      if (!device) continue;
      state("xiaoai_conversation", speaker.deviceID, device.did);
      await run("xiaoai_conversation", speaker.deviceID, async (diagnostic) => {
        const access = accessMaterialDevice(
          deps.mijia,
          scope,
          speaker.miotDID,
          signal,
        );
        await collectSpeakerConversations({
          access,
          speaker,
          config: deps.config,
          save,
          diagnostic,
        });
      });
    }
  }
  async function collectSceneHistory(scope: Scope) {
    const session = deps.mijia.materialSession(signal);
    const previous = state("mijia_scene_execution", "current");
    if (previous.error === "home_owner_id_unavailable" && session.home.ownerId)
      gates.delete(JSON.stringify(["mijia_scene_execution", "current"]));
    await run("mijia_scene_execution", "current", async (diagnostic) => {
      if (!session.home.ownerId) {
        diagnostic.status = "limited";
        diagnostic.suspended = true;
        diagnostic.error = "home_owner_id_unavailable";
        return;
      }
      const response = await session.client.sceneHistory(
        session.home.id,
        session.home.ownerId,
        session.signal,
      );
      scope.assertCurrent();
      session.assertCurrent();
      success(diagnostic, response.history.length, [
        "execution_identity_unverified",
        "target_semantics_and_pagination_unverified",
        "records_not_admitted",
      ]);
      diagnostic.status = "limited";
      diagnostic.suspended = true;
    });
  }
  async function collectDeviceHistory(
    input: ReturnType<typeof deviceHistoryCollectionSchema.parse>,
  ) {
    synchronizeScope();
    if (closed || signal.aborted) throw new MijiaError("stale_session");
    const { scope, session, device } = accessMaterialDevice(
      deps.mijia,
      accessHousehold(deps.household, input.scope_epoch),
      input.device_id,
      signal,
    );
    const owner = JSON.stringify([input.device_id, input.api]);
    const previousDiagnostic = state("mijia_device_history", owner, device.did);
    const { scope_epoch: _epoch, ...query } = input;
    if (
      JSON.stringify(previousDiagnostic.query) !== JSON.stringify(query) ||
      (previousDiagnostic.suspended &&
        (previousDiagnostic.error === "key_type_not_verified" ||
          previousDiagnostic.error === "model_not_supported_by_interface"))
    )
      gates.delete(JSON.stringify(["mijia_device_history", owner]));
    return run(
      "mijia_device_history",
      owner,
      async (diagnostic) => {
        const range = {
          did: device.did,
          time_start: Math.floor(Date.parse(input.start) / 1000),
          time_end: Math.ceil(Date.parse(input.end) / 1000),
          limit: input.limit,
        };
        let rows: Awaited<
          ReturnType<
            (typeof session.client)["getDeviceData" | "getUserDeviceLog"]
          >
        >;
        if (input.api === "getUserDeviceLog") {
          if (!device.model?.startsWith("lumi.")) {
            diagnostic.status = "unsupported";
            diagnostic.suspended = true;
            diagnostic.error = "model_not_supported_by_interface";
            return;
          }
          rows = await session.client.getUserDeviceLog(range, session.signal);
        } else {
          const ble =
            device.model === "miaomiaoce.sensor_ht.t9" &&
            input.type === "prop" &&
            input.key === "4100";
          const specification = ble
            ? undefined
            : deps.mijia.getDeviceSpec(device.did, session.signal);
          const known =
            ble ||
            ((input.type === "prop" || input.type === "event") &&
              /^\d+\.\d+$/.test(input.key) &&
              specification?.spec[`${input.type}.${input.key}`] !== undefined);
          if (!known) {
            diagnostic.status = "limited";
            diagnostic.suspended = true;
            diagnostic.error = "key_type_not_verified";
            return;
          }
          rows =
            input.api === "getDeviceData"
              ? await session.client.getDeviceData(
                  { ...range, key: input.key, type: input.type },
                  session.signal,
                )
              : await session.client.getDeviceDataRaw(
                  { ...range, key: input.key, type: input.type },
                  session.signal,
                );
        }
        session.assertCurrent();
        scope.assertCurrent();
        if (!session.devices().some((item) => item.did === device.did))
          throw new MijiaError("device_not_found");
        success(
          diagnostic,
          rows.length,
          rows.length
            ? [
                "record_identity_unverified",
                "records_not_admitted",
                ...(rows.length >= input.limit
                  ? ["full_page_without_verified_cursor"]
                  : []),
              ]
            : [],
        );
        diagnostic.suspended = rows.length > 0;
      },
      false,
      query,
    );
  }
  async function tick() {
    if (closed) return;
    synchronizeScope();
    if (!deps.household.ready) return;
    let generation = sourceGeneration;
    try {
      const scope = accessHousehold(deps.household, deps.household.epoch);
      const source = deps.mijia.materialSession(signal);
      if (sourceRevision !== source.revision) {
        clearSources();
        sourceRevision = source.revision;
      }
      generation = sourceGeneration;
      state("mijia_device_history", "on_request").limitations = [
        "requires_explicit_device_and_time_range",
      ];
      states.delete(JSON.stringify(["sources", "current_household"]));
      state("mico_auth", "current");
      state("mijia_scene_execution", "current");
      eventSubscriptions.observe(scope);
      await Promise.all([
        collectConversations(scope),
        collectSceneHistory(scope),
      ]);
    } catch (error) {
      if (closed || generation !== sourceGeneration) return;
      clearSources();
      failure(state("sources", "current_household"), error);
    }
  }
  function scheduleTick() {
    if (ticking || closed) return;
    ticking = tick()
      .catch(() => {
        console.warn("Material collection interrupted");
      })
      .finally(() => {
        ticking = undefined;
      });
  }
  const timer = setInterval(scheduleTick, 30_000);
  timer.unref();
  const unsubscribeScope = deps.household.subscribe(synchronizeScope);
  scheduleTick();
  return {
    collectDeviceHistory,
    diagnostics: () => {
      synchronizeScope();
      return {
        collectors: structuredClone([...states.values()]),
        queue: deps.writer.diagnostics(),
      };
    },
    async close() {
      closed = true;
      unsubscribeScope();
      clearSources();
      controller.abort();
      clearInterval(timer);
      await ticking;
      await requests.onIdle();
    },
  };
}
