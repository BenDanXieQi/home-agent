import type { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { freeze } from "@home-agent/api/immutable";
import {
  agentContextPolicy,
  agentContextPartsSchema,
  agentContextScopeSchema,
  agentContextSnapshotSchema,
  agentContextDataSchemas,
} from "@home-agent/api/agent-context";
import { accessHousehold } from "../household/access";
import type { HouseholdRuntime } from "../household/runtime";
import type { createMemberRepository } from "../household/members/repository";
import type { createMemberActivityRepository } from "../household/identity/activity-repository";
import type { createPerceptionService } from "../perception/service";
import { HouseholdError } from "../household/errors";
import { jsonBytes } from "../household/config";

function emptyParts(available: boolean) {
  const state = available
    ? { status: "loading" as const, reason: null }
    : { status: "unavailable" as const, reason: "household_unavailable" };
  const part = { ...state, read_at: null, data: null, truncated: false };
  return agentContextPartsSchema.parse({
    household: part,
    device_state: part,
    members: part,
    member_sightings: part,
    perception: part,
  });
}

function ready<T>(data: T, truncated = false) {
  return { status: "ready" as const, data, truncated };
}
function unavailable(reason: string) {
  return { status: "unavailable" as const, reason };
}
function loading() {
  return { status: "loading" as const };
}

/** One owner refreshes source parts; connections only consume its committed views. */
export function createAgentContextService(options: {
  household: HouseholdRuntime;
  members: ReturnType<typeof createMemberRepository> | undefined;
  sightings: ReturnType<typeof createMemberActivityRepository> | undefined;
  perception: ReturnType<typeof createPerceptionService>;
}) {
  const { household, members, sightings, perception } = options;
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
    household: 0,
    device_state: 0,
    members: 0,
    member_sightings: 0,
    perception: 0,
  };
  const partNames = agentContextPartsSchema.keyof().options;
  const partSizes = { ...revisions };
  for (const key of partNames) partSizes[key] = jsonBytes(parts[key]);
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
      const bytes = jsonBytes(value);
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
      household: update.household ?? parts.household,
      device_state: update.device_state ?? parts.device_state,
      members: update.members ?? parts.members,
      member_sightings: update.member_sightings ?? parts.member_sightings,
      perception: update.perception ?? parts.perception,
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
  function lane<K extends keyof typeof revisions>(
    key: K,
    read: (
      access: ReturnType<typeof accessHousehold>,
    ) => Promise<
      | ReturnType<typeof ready<z.infer<(typeof agentContextDataSchemas)[K]>>>
      | ReturnType<typeof unavailable>
      | ReturnType<typeof loading>
    >,
  ) {
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
        const result = await read(access);
        access.assertCurrent();
        if (closed || captured !== generation) return;
        if (
          (key === "household" ||
            key === "device_state" ||
            key === "perception") &&
          household.snapshot().projection.device !==
            access.snapshot.projection.device
        ) {
          dirty = true;
          return;
        }
        const value =
          result.status === "ready"
            ? { ...result, read_at: new Date().toISOString(), reason: null }
            : {
                ...result,
                read_at:
                  result.status === "loading" ? null : new Date().toISOString(),
                data: null,
                truncated: false as const,
                reason: result.status === "unavailable" ? result.reason : null,
              };
        publish({ [key]: value });
        retryMs = agentContextPolicy.retryInitialMs;
      } catch (error) {
        if (closed || captured !== generation) return;
        const capacity =
          error instanceof HouseholdError &&
          error.reason === "capacity_exceeded";
        publish({
          [key]: {
            status: "failed",
            read_at: new Date().toISOString(),
            data: null,
            reason: capacity ? "capacity_exceeded" : "read_failed",
            truncated: false,
          },
        });
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
  const householdLane = lane("household", async ({ snapshot }) => {
    const projection = snapshot.projection;
    return ready(
      agentContextDataSchemas.household.parse({
        ...projection,
        specs: household.specifications(),
      }),
    );
  });
  const deviceLane = lane("device_state", async ({ snapshot }) =>
    ready(
      agentContextDataSchemas.device_state.parse({
        ...snapshot.projection,
        online: Object.values(snapshot.projection.device).filter(
          (device) => !device.archived,
        ),
      }),
    ),
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
  const sightingsLane = lane("member_sightings", async (access) => {
    if (!sightings) return unavailable("storage_not_configured");
    const result = await sightings.recent(
      access.identity,
      access.assertCurrent,
    );
    const records: typeof result.records = [];
    let bytes = jsonBytes({
      status: "ready",
      read_at: new Date().toISOString(),
      reason: null,
      truncated: false,
      data: { records },
    });
    for (const record of result.records) {
      const size = jsonBytes(record) + (records.length ? 1 : 0);
      if (bytes + size > agentContextPolicy.partBytes.member_sightings) break;
      records.push(record);
      bytes += size;
    }
    return ready(
      { records },
      result.truncated || records.length < result.records.length,
    );
  });
  let cachedWindows:
    | {
        revision: number;
        sources: string;
        entries: {
          window: z.infer<
            typeof agentContextDataSchemas.perception
          >["windows"][number];
          bytes: number;
        }[];
        truncated: boolean;
      }
    | undefined;
  const perceptionLane = lane("perception", async () => {
    const view = perception.snapshot();
    if (view.status === "starting") return loading();
    if (view.status === "disabled" || view.status === "closed")
      return unavailable(`perception_${view.status}`);
    if (view.status === "unavailable")
      throw new Error("Perception unavailable");
    const snapshot = agentContextDataSchemas.perception.shape.snapshot.parse({
      ...view,
      settings: view.config,
    });
    const sources = JSON.stringify([
      household.epoch,
      snapshot.sources.map(({ source }) => source),
    ]);
    const revision = perception.windowRevision();
    if (
      !cachedWindows ||
      cachedWindows.revision !== revision ||
      cachedWindows.sources !== sources
    ) {
      const entries: NonNullable<typeof cachedWindows>["entries"] = [];
      cachedWindows = undefined;
      const candidates = snapshot.sources
        .flatMap(
          ({ source }) =>
            perception.windows({ ...source, scopeEpoch: household.epoch })
              .windows,
        )
        .toSorted((a, b) => b.endedAt - a.endedAt || b.id.localeCompare(a.id));
      let bytes = 0;
      let truncated = false;
      for (const candidate of candidates) {
        if (entries.length === agentContextPolicy.recentWindows) {
          truncated = true;
          break;
        }
        const detail = perception.window(candidate.id);
        if (!detail) continue;
        const window = freeze(
          agentContextDataSchemas.perception.shape.windows.element.parse(
            detail,
          ),
        );
        const size = jsonBytes(window);
        if (size > agentContextPolicy.partBytes.perception)
          throw new HouseholdError("capacity_exceeded");
        if (
          bytes + size + (entries.length ? 1 : 0) >
          agentContextPolicy.partBytes.perception
        ) {
          truncated = true;
          break;
        }
        entries.push({ window, bytes: size });
        bytes += size + (entries.length > 1 ? 1 : 0);
      }
      cachedWindows = { revision, sources, entries, truncated };
    }
    const windows: z.infer<
      typeof agentContextDataSchemas.perception
    >["windows"] = [];
    const envelopeBytes = jsonBytes({
      status: "ready",
      data: { snapshot, windows },
      read_at: new Date().toISOString(),
      reason: null,
      truncated: false,
    });
    let windowBytes = 0;
    let truncated = cachedWindows.truncated;
    for (const { window, bytes: size } of cachedWindows.entries) {
      if (envelopeBytes + size > agentContextPolicy.partBytes.perception)
        throw new HouseholdError("capacity_exceeded");
      const addedBytes = size + (windows.length ? 1 : 0);
      if (
        envelopeBytes + windowBytes + addedBytes >
        agentContextPolicy.partBytes.perception
      ) {
        truncated = true;
        break;
      }
      windows.push(window);
      windowBytes += addedBytes;
    }
    return ready({ snapshot, windows }, truncated);
  });
  const lanes = [
    householdLane,
    deviceLane,
    membersLane,
    sightingsLane,
    perceptionLane,
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
      cachedWindows = undefined;
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
    sightings?.subscribe(sightingsLane.refresh),
    perception.subscribeContext(perceptionLane.refresh),
  ];
  if (eligible) for (const source of lanes) source.refresh();
  return {
    snapshot: () => ({ scope, parts }),
    revisions: () => ({ ...revisions }),
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
      cachedWindows = undefined;
      for (const release of releases) release?.();
      parts = freeze(emptyParts(false));
      listeners.clear();
      await Promise.all(lanes.map((source) => source.close()));
    },
  };
}
