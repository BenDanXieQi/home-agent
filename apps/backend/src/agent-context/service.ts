import type { projectWindowObservation } from "@home-agent/api/perception/window-observations";
import type { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { freeze } from "@home-agent/api/immutable";
import {
  agentContextPolicy,
  agentContextPartsSchema,
  agentContextScopeSchema,
  agentContextSnapshotSchema,
  agentContextDataSchemas,
  agentObservationSourceSchema,
} from "@home-agent/api/agent-context";
import { accessHousehold } from "../household/access";
import type { HouseholdRuntime } from "../household/runtime";
import type { createSpatialRepository } from "../household/spatial/repository";
import type { createMemberRepository } from "../household/members/repository";
import type { createMemberActivityRepository } from "../household/identity/activity-repository";
import type { createPerceptionService } from "../perception/service";
import { HouseholdError } from "../household/errors";
import {
  assembleAgentObservations,
  memberObservationSchema,
  latestMemberObservations,
  sightingStateKey,
} from "@home-agent/api/agent-context/observations";
import { jsonBytes } from "../household/config";
import { createAgentDeviceStateProjection } from "./device-state";

function observationSourceState(
  source: z.infer<typeof agentObservationSourceSchema>,
) {
  const { read_at: _readAt, ...state } = source;
  return state;
}

function emptyParts(available: boolean) {
  const state = available
    ? { status: "loading" as const, reason: null }
    : { status: "unavailable" as const, reason: "household_unavailable" };
  const part = { ...state, read_at: null, data: null, truncated: false };
  return agentContextPartsSchema.parse({
    spatial: part,
    household: part,
    device_state: part,
    members: part,
    observations: part,
  });
}

function ready<T>(data: T) {
  return { status: "ready" as const, data, truncated: false };
}
function unavailable(reason: string) {
  return { status: "unavailable" as const, reason };
}

function observationSource(
  status: z.infer<typeof agentObservationSourceSchema>["status"] = "loading",
  reason: string | null = null,
) {
  return agentObservationSourceSchema.parse({
    status,
    reason,
    truncated: false,
    read_at: status === "loading" ? null : new Date().toISOString(),
  });
}
/** One owner refreshes source parts; connections only consume its committed views. */
export function createAgentContextService(options: {
  household: HouseholdRuntime;
  members: ReturnType<typeof createMemberRepository> | undefined;
  spatial: ReturnType<typeof createSpatialRepository> | undefined;
  sightings: ReturnType<typeof createMemberActivityRepository> | undefined;
  perception: ReturnType<typeof createPerceptionService>;
}) {
  const { household, members, sightings, perception, spatial } = options;
  const listeners = new Set<
    (snapshot: z.infer<typeof agentContextSnapshotSchema>) => void
  >();
  let closed = false;
  let generation = 0;
  let eligible = household.ready;
  function currentScope(snapshot = household.snapshot()) {
    const binding = snapshot.projection.household.household;
    return binding.account_id && binding.home_id
      ? agentContextScopeSchema.parse({
          account_id: binding.account_id,
          home_id: binding.home_id,
          scope_epoch: snapshot.scope_epoch,
        })
      : null;
  }
  let scope = currentScope();
  let parts = freeze(emptyParts(eligible));
  const revisions = {
    spatial: 0,
    household: 0,
    device_state: 0,
    members: 0,
    observations: 0,
  };
  const partNames = agentContextPartsSchema.keyof().options;
  const partSizes = { ...revisions };
  const encodedParts = new WeakMap<object, { data: string; bytes: number }>();
  function encodePart(value: object) {
    const cached = encodedParts.get(value);
    if (cached) return cached;
    const data = JSON.stringify(value);
    const encoded = { data, bytes: Buffer.byteLength(data) };
    encodedParts.set(value, encoded);
    return encoded;
  }
  for (const key of partNames) partSizes[key] = encodePart(parts[key]).bytes;
  let cacheBytes = jsonBytes({ scope, parts });
  let scopeBytes = jsonBytes(scope);
  function publish(
    update: z.infer<typeof agentContextSnapshotSchema>["parts"],
  ) {
    const nextScopeBytes = jsonBytes(scope);
    let nextBytes = cacheBytes + nextScopeBytes - scopeBytes;
    const sizes = { ...partSizes };
    for (const key of partNames) {
      const value = update[key];
      if (value === undefined) continue;
      const bytes = encodePart(value).bytes;
      if (bytes > agentContextPolicy.partBytes[key])
        throw new HouseholdError("capacity_exceeded");
      nextBytes += bytes - partSizes[key];
      sizes[key] = bytes;
    }
    if (nextBytes > agentContextPolicy.cacheBytes)
      throw new HouseholdError("capacity_exceeded");
    const snapshot = freeze({ scope, parts: update });
    // Each updated part was validated by its reader; retain the other owned values.
    parts = freeze({
      spatial: update.spatial ?? parts.spatial,
      household: update.household ?? parts.household,
      device_state: update.device_state ?? parts.device_state,
      members: update.members ?? parts.members,
      observations: update.observations ?? parts.observations,
    });
    Object.assign(partSizes, sizes);
    cacheBytes = nextBytes;
    scopeBytes = nextScopeBytes;
    for (const key of partNames)
      if (update[key] !== undefined) revisions[key]++;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("Agent context subscriber failed", error);
      }
    }
  }
  function refreshSource<T>(sourceOptions: {
    read: (access: ReturnType<typeof accessHousehold>) => Promise<T>;
    commit: (result: T) => void;
    failed: (reason: string) => void;
    tracksDevices?: boolean;
  }) {
    let dirty = false;
    let running = false;
    let pending = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryMs: number = agentContextPolicy.retryInitialMs;
    function refresh() {
      if (closed) return;
      dirty = true;
      if (timer) return;
      if (!running && eligible) {
        running = true;
        pending = Promise.resolve()
          .then(run)
          .catch((error: unknown) => {
            console.error("Agent context refresh failed", error);
          });
      }
    }
    async function run() {
      if (!dirty || closed || !eligible) {
        running = false;
        return;
      }
      dirty = false;
      const captured = generation;
      try {
        const access = accessHousehold(household, household.epoch);
        const result = await sourceOptions.read(access);
        access.assertCurrent();
        if (closed || captured !== generation) return;
        if (
          sourceOptions.tracksDevices &&
          household.snapshot().projection.device !==
            access.snapshot.projection.device
        ) {
          dirty = true;
          return;
        }
        sourceOptions.commit(result);
        retryMs = agentContextPolicy.retryInitialMs;
      } catch (error) {
        if (closed || captured !== generation) return;
        const capacity =
          error instanceof HouseholdError &&
          error.reason === "capacity_exceeded";
        sourceOptions.failed(capacity ? "capacity_exceeded" : "read_failed");
        timer = setTimeout(() => {
          timer = undefined;
          refresh();
        }, retryMs);
        retryMs = Math.min(retryMs * 2, agentContextPolicy.retryMaxMs);
      } finally {
        running = false;
        if (dirty && !closed && eligible) refresh();
      }
    }
    return {
      refresh,
      reset() {
        clearTimeout(timer);
        timer = undefined;
        retryMs = agentContextPolicy.retryInitialMs;
        dirty = true;
      },
      close() {
        clearTimeout(timer);
        return pending;
      },
    };
  }
  function lane<K extends keyof typeof revisions>(
    key: K,
    read: (
      access: ReturnType<typeof accessHousehold>,
    ) => Promise<
      | ReturnType<typeof ready<z.infer<(typeof agentContextDataSchemas)[K]>>>
      | ReturnType<typeof unavailable>
    >,
  ) {
    return refreshSource({
      read,
      tracksDevices: key === "household" || key === "device_state",
      commit(result) {
        if (key === "observations" && result.status === "ready") {
          const next = agentContextDataSchemas.observations.parse(result.data);
          const old = parts.observations;
          if (
            old.status === "ready" &&
            isDeepStrictEqual(old.data.records, next.records) &&
            isDeepStrictEqual(
              old.data.member_sightings,
              next.member_sightings,
            ) &&
            (["member_sightings", "perception"] as const).every((name) =>
              isDeepStrictEqual(
                observationSourceState(old.data.sources[name]),
                observationSourceState(next.sources[name]),
              ),
            )
          )
            return;
        }
        publish({
          [key]:
            result.status === "ready"
              ? { ...result, read_at: new Date().toISOString(), reason: null }
              : {
                  ...result,
                  read_at: new Date().toISOString(),
                  data: null,
                  truncated: false,
                },
        });
      },
      failed(reason) {
        publish({
          [key]: {
            status: "failed",
            read_at: new Date().toISOString(),
            data: null,
            reason,
            truncated: false,
          },
        });
      },
    });
  }
  const spatialLane = lane("spatial", async ({ identity, assertCurrent }) => {
    if (!spatial) return unavailable("storage_unavailable");
    const result = await spatial.read();
    assertCurrent();
    if (
      result.scope?.account_id !== identity.accountId ||
      result.scope?.home_id !== identity.homeId
    )
      throw new HouseholdError("stale_session");
    return ready(agentContextDataSchemas.spatial.parse(result));
  });
  const householdLane = lane("household", async ({ snapshot }) => {
    const projection = snapshot.projection;
    return ready(
      agentContextDataSchemas.household.parse({
        ...projection,
        specs: household.specifications(),
      }),
    );
  });
  const projectDeviceState = createAgentDeviceStateProjection();
  const deviceLane = lane("device_state", async ({ snapshot }) =>
    ready(projectDeviceState(snapshot.projection)),
  );
  const membersLane = lane("members", async (access) =>
    members
      ? ready(
          agentContextDataSchemas.members.parse(
            await members.access(access.identity, access.assertCurrent),
          ),
        )
      : unavailable("storage_not_configured"),
  );
  let sightingSource = {
    state: observationSource(),
    records: [] as z.infer<typeof memberObservationSchema>[],
    capacityExceeded: false,
  };
  let windowSource = {
    state: observationSource(),
    records: [] as ReturnType<typeof projectWindowObservation>[],
  };
  let windowVersion: { revision: number; sources: string } | undefined;
  let observationExpiry: ReturnType<typeof setTimeout> | undefined;
  const observationsLane = lane("observations", async () => {
    clearTimeout(observationExpiry);
    observationExpiry = undefined;
    const end = Date.now();
    const start = end - agentContextPolicy.recentObservationMs;
    const latestIds = new Set(
      latestMemberObservations(sightingSource.records).map(
        (record) => record.id,
      ),
    );
    sightingSource.records = sightingSource.records.filter(
      (record) =>
        latestIds.has(record.id) || record.data.lastObservedAt >= start,
    );
    windowSource.records = windowSource.records.filter(
      (record) => record.endedAt >= start,
    );
    const oldest = [
      ...sightingSource.records
        .filter((record) => !latestIds.has(record.id))
        .map((record) => record.data.lastObservedAt),
      ...windowSource.records.map((record) => record.endedAt),
    ].reduce((minimum, at) => Math.min(minimum, at), Infinity);
    if (Number.isFinite(oldest)) {
      observationExpiry = setTimeout(
        () => {
          observationsLane.refresh();
          if (sightingSource.capacityExceeded) sightingsLane.refresh();
        },
        Math.max(1, oldest + agentContextPolicy.recentObservationMs + 1 - end),
      );
      observationExpiry.unref();
    }
    if (sightingSource.capacityExceeded)
      throw new HouseholdError("capacity_exceeded");
    return ready({
      ...assembleAgentObservations(
        sightingSource.records,
        windowSource.records,
      ),
      as_of: new Date(end).toISOString(),
      sources: {
        member_sightings: sightingSource.state,
        perception: windowSource.state,
      },
    });
  });
  const sightingsLane = refreshSource({
    async read(access) {
      if (!sightings)
        return {
          state: observationSource("unavailable", "storage_not_configured"),
          records: [] as typeof sightingSource.records,
          capacityExceeded: false,
        };
      const records: typeof sightingSource.records = [];
      let referenceBytes = 2;
      const latestTimes = new Map<string, number>();
      const complete = await sightings.currentObservations(
        access.identity,
        access.assertCurrent,
        Date.now() - agentContextPolicy.recentObservationMs,
        (record) => {
          const key = sightingStateKey(record);
          if (!latestTimes.has(key))
            latestTimes.set(key, record.data.lastObservedAt);
          // Recent association rows are internal; only latest sightings must be published.
          if (latestTimes.get(key) === record.data.lastObservedAt)
            referenceBytes += jsonBytes(record.id) + 1;
          if (referenceBytes > agentContextPolicy.partBytes.observations)
            return false;
          records.push(record);
          return true;
        },
      );
      return {
        state: observationSource("ready"),
        records,
        capacityExceeded: !complete,
      };
    },
    commit(result) {
      sightingSource = result;
      observationsLane.refresh();
    },
    failed(reason) {
      sightingSource = {
        state: observationSource("failed", reason),
        records: [],
        capacityExceeded: false,
      };
      observationsLane.refresh();
    },
  });
  const windowsLane = refreshSource({
    tracksDevices: true,
    async read() {
      const view = perception.snapshot();
      const sources = JSON.stringify([
        household.epoch,
        view.status,
        view.sources.map(({ source }) => source),
      ]);
      const revision = perception.windowRevision();
      if (
        windowVersion?.revision === revision &&
        windowVersion.sources === sources
      )
        return windowSource;
      if (view.status !== "running" && view.status !== "recovering") {
        return {
          state: observationSource(
            view.status === "starting" ? "loading" : "unavailable",
            view.status === "starting" ? null : `perception_${view.status}`,
          ),
          records: [] as typeof windowSource.records,
          version: { revision, sources },
        };
      }
      const candidates = view.sources
        .flatMap(
          ({ source }) =>
            perception.windows({ ...source, scopeEpoch: household.epoch })
              .windows,
        )
        .toSorted((a, b) => b.endedAt - a.endedAt || b.id.localeCompare(a.id));
      const since = Date.now() - agentContextPolicy.recentObservationMs;
      const previous = new Map(
        windowSource.records.map((record) => [record.id, record]),
      );
      const records = candidates
        .filter((candidate) => candidate.endedAt >= since)
        .flatMap((candidate) => {
          const cached = previous.get(candidate.id);
          if (
            cached &&
            cached.material.revision === candidate.revision &&
            cached.material.inputState === candidate.inputState &&
            isDeepStrictEqual(
              cached.material.sampledMedia,
              candidate.sampledMedia,
            )
          )
            return [cached];
          const observation = perception.windowObservation(candidate.id);
          return observation ? [observation] : [];
        });
      return {
        state: observationSource("ready"),
        records,
        version: { revision, sources },
      };
    },
    commit(result) {
      if (result === windowSource) return;
      windowVersion = "version" in result ? result.version : undefined;
      windowSource = { state: result.state, records: result.records };
      observationsLane.refresh();
    },
    failed(reason) {
      windowVersion = undefined;
      windowSource = {
        state: observationSource("failed", reason),
        records: [],
      };
      observationsLane.refresh();
    },
  });
  function resetObservations() {
    clearTimeout(observationExpiry);
    observationExpiry = undefined;
    sightingSource = {
      state: observationSource(),
      records: [],
      capacityExceeded: false,
    };
    windowSource = { state: observationSource(), records: [] };
    windowVersion = undefined;
  }
  const lanes = [
    spatialLane,
    householdLane,
    deviceLane,
    membersLane,
    observationsLane,
    sightingsLane,
    windowsLane,
  ];
  const householdFields = agentContextDataSchemas.household
    .keyof()
    .options.filter((key) => key !== "specs");
  const deviceFields = agentContextDataSchemas.device_state
    .keyof()
    .options.filter((key) => key !== "online");
  let projection = household.snapshot().projection;
  let specifications = household.specifications();
  function householdChanged() {
    const snapshot = household.snapshot();
    const next = currentScope(snapshot);
    const nextEligible = household.ready;
    const nextProjection = snapshot.projection;
    const nextSpecifications = household.specifications();
    const inventoryChanged =
      householdFields.some((key) => projection[key] !== nextProjection[key]) ||
      Object.keys(specifications).length !==
        Object.keys(nextSpecifications).length ||
      Object.entries(specifications).some(
        ([id, spec]) => spec !== nextSpecifications[id],
      );
    const stateChanged =
      projection.device !== nextProjection.device ||
      deviceFields.some((key) => projection[key] !== nextProjection[key]);
    projection = nextProjection;
    specifications = nextSpecifications;
    if (!isDeepStrictEqual(scope, next) || eligible !== nextEligible) {
      generation++;
      resetObservations();
      scope = next;
      eligible = nextEligible;
      for (const source of lanes) source.reset();
      publish(emptyParts(eligible));
      if (eligible) for (const source of lanes) source.refresh();
    } else {
      if (inventoryChanged) householdLane.refresh();
      if (stateChanged) deviceLane.refresh();
    }
  }
  // Register all notifications before starting the initial asynchronous reads.
  const releases = [
    household.subscribe(householdChanged),
    members?.subscribe(membersLane.refresh),
    spatial?.subscribe(spatialLane.refresh),
    sightings?.subscribe(sightingsLane.refresh),
    perception.subscribeContext(windowsLane.refresh),
  ];
  if (eligible) for (const source of lanes) source.refresh();
  return {
    snapshot: () => ({ scope, parts }),
    revisions: () => ({ ...revisions }),
    publicationBytes(snapshot: z.infer<typeof agentContextSnapshotSchema>) {
      let bytes = jsonBytes({ scope: snapshot.scope, parts: {} });
      let count = 0;
      for (const [key, part] of Object.entries(snapshot.parts)) {
        if (part === undefined) continue;
        bytes += jsonBytes(key) + 1 + encodePart(part).bytes;
        count++;
      }
      return bytes + Math.max(0, count - 1);
    },
    serialize(snapshot: z.infer<typeof agentContextSnapshotSchema>) {
      const entries = Object.entries(snapshot.parts).flatMap(([key, part]) =>
        part === undefined
          ? []
          : [`${JSON.stringify(key)}:${encodePart(part).data}`],
      );
      return `{"scope":${JSON.stringify(snapshot.scope)},"parts":{${entries.join(",")}}}`;
    },
    subscribe(listener: Parameters<typeof listeners.add>[0]) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      generation++;
      resetObservations();
      for (const release of releases) release?.();
      parts = freeze(emptyParts(false));
      listeners.clear();
      await Promise.all(lanes.map((source) => source.close()));
    },
  };
}
