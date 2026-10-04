import { produce } from "@home-agent/api/immutable";
import { entityKey, type Projection } from "@home-agent/api/household";
import {
  latestPropertySchema,
  propertyKey,
  type HouseholdObservation,
} from "@home-agent/api/observations";
import type { specSchema } from "@home-agent/api/household";
type Capability = ReturnType<typeof specSchema.parse>["spec"][string];
import { collectionLimits, propertyPolicy } from "./collection-policy";
import { jsonBytes } from "./config";

type Latest = Projection["latest"][string];
export type PropertyDefinition = {
  device: Projection["device"][string];
  siid: number;
  piid: number;
  capability: Capability | undefined;
  policy: ReturnType<typeof propertyPolicy>;
  policy_version: string;
};
export type FactInput =
  | {
      kind: "configure";
      definitions: PropertyDefinition[];
      supported: string[];
      policy_version: string;
    }
  | {
      kind: "observe";
      event: HouseholdObservation;
      definition: PropertyDefinition | undefined;
      observation_id: string;
      tick: number;
    }
  | { kind: "expire"; tick: number; at: string }
  | {
      kind: "gap";
      reason: string;
      dropped: number;
      paused: boolean;
      at: string;
    }
  | {
      kind: "status";
      status: Projection["collection"]["collection"]["status"];
      reason: string | null;
    };
export function initialFactState() {
  return {
    deadlines: {} as Record<string, number>,
    online_updates: {} as Record<string, number>,
    latest_bytes: 2,
  };
}
export function emptyProperty(definition: PropertyDefinition) {
  const { device, siid, piid, capability } = definition;
  return latestPropertySchema.parse({
    account_id: device.account_id,
    home_id: device.home_id ?? "",
    room_id: device.room_id ?? null,
    device_id: device.id,
    siid,
    piid,
    spec_id: device.spec_id,
    description: (capability?.description ?? `prop.${siid}.${piid}`).slice(
      0,
      512,
    ),
    type_name: capability?.type_name ?? null,
    service_type_name: capability?.service_type_name ?? null,
    readable: capability?.readable ?? false,
    unit: capability?.unit ?? null,
    has_value: false,
    value: null,
    reason: capability ? "missing" : "spec_unknown",
    rule_eligible: false,
    evidence: null,
    applied_at: null,
    expires_at: null,
    last_report_at: null,
    last_change_at: null,
    last_read_at: null,
    read_candidate: null,
  });
}
function matchesCapability(value: Latest["value"], capability: Capability) {
  const format = capability.format.toLowerCase();
  const integer = /^(u?int)(8|16|32|64)$/.exec(format);
  const known =
    integer || ["bool", "string", "float", "double"].includes(format);
  if (!known) return "unknown" as const;
  if (format === "bool" && typeof value !== "boolean")
    return "invalid" as const;
  if (format === "string" && typeof value !== "string")
    return "invalid" as const;
  if (
    (integer || format === "float" || format === "double") &&
    typeof value !== "number"
  )
    return "invalid" as const;
  if (integer && typeof value === "number") {
    const bits = Number(integer[2]);
    const unsigned = integer[1] === "uint";
    if (
      !Number.isSafeInteger(value) ||
      value < (unsigned ? 0 : -(2 ** (bits - 1))) ||
      value >= 2 ** (unsigned ? bits : bits - 1)
    )
      return "invalid" as const;
  }
  if (
    capability.value_list?.length &&
    !capability.value_list.some((item) => item.value === value)
  )
    return "invalid" as const;
  if (typeof value === "number" && capability.value_range) {
    const [min, max, step] = capability.value_range;
    if (value < min || value > max) return "invalid" as const;
    if (
      step > 0 &&
      Math.abs((value - min) / step - Math.round((value - min) / step)) > 1e-5
    )
      return "invalid" as const;
  }
  return "valid" as const;
}

/** Remove revoked facts in the same commit as the inventory; never publish an orphan. */
export function reconcileFactScope(before: Projection, candidate: Projection) {
  if (
    before.device === candidate.device &&
    before.household.household.status === candidate.household.household.status
  )
    return candidate;
  return produce(candidate, (draft) => {
    const scope = draft.household.household;
    const stopped = scope.status === "stopping";
    for (const [key, fact] of Object.entries(draft.latest)) {
      const deviceKey = entityKey(fact.account_id, fact.device_id);
      const device = draft.device[deviceKey];
      if (
        !device ||
        device.archived ||
        device.account_id !== scope.account_id
      ) {
        delete draft.latest[key];
        continue;
      }
      const previous = before.device[deviceKey];
      if (
        previous &&
        (previous.model !== device.model || previous.spec_id !== device.spec_id)
      ) {
        fact.reason = "spec_changed";
        fact.rule_eligible = false;
        fact.expires_at = null;
        fact.read_candidate = null;
      }
      fact.room_id = device.room_id ?? null;
      if (
        previous?.online &&
        !device.online &&
        fact.evidence?.source === "push"
      ) {
        fact.reason = "offline";
        fact.rule_eligible = false;
        fact.expires_at = null;
      }
      if (stopped) {
        fact.reason = "stopped";
        fact.rule_eligible = false;
        fact.expires_at = null;
      }
    }
    for (const [key, coverage] of Object.entries(draft.device_coverage)) {
      if (!draft.device[key]) {
        delete draft.device_coverage[key];
        continue;
      }
      if (stopped) {
        coverage.properties = "cancelled";
        coverage.online = "cancelled";
      }
    }
    if (!Object.keys(draft.device).length) draft.source_health = {};
    if (stopped) {
      draft.collection.collection.status = "idle";
      draft.collection.collection.reason = "stopped";
    }
  });
}

/** Ordinary synchronous domain reduction; the household actor owns the resulting state. */
export function reduceFacts(
  projection: Projection,
  previous: ReturnType<typeof initialFactState>,
  input: FactInput,
  sequence: number,
  clock: { tick: number; at: string },
) {
  const state = {
    deadlines: { ...previous.deadlines },
    online_updates: previous.online_updates,
    latest_bytes: previous.latest_bytes,
  };
  let receipt: {
    outcome: "applied" | "candidate" | "unchanged" | "failed";
    reason: string | null;
    observation_id: string | null;
  } = {
    outcome: "unchanged",
    reason: null,
    observation_id: null,
  };
  const accepted: {
    observation: {
      event: HouseholdObservation;
      observation_id: string;
      input_sequence: number;
    } | null;
  } = { observation: null };
  const edges: { key: string; before: Latest; after: Latest }[] = [];
  const output = produce(projection, (draft) => {
    const status = draft.collection.collection;
    const account = draft.household.household.account_id;
    const invalidate = (
      predicate: (fact: Latest) => boolean,
      reason: Latest["reason"],
    ) => {
      for (const [key, fact] of Object.entries(draft.latest)) {
        if (!predicate(fact)) continue;
        fact.reason = reason;
        fact.rule_eligible = false;
        fact.expires_at = null;
        delete state.deadlines[key];
      }
    };
    if (input.kind === "status") {
      status.status = input.status;
      status.reason = input.reason;
      return;
    }
    if (input.kind === "gap") {
      status.gaps++;
      status.dropped += input.dropped;
      status.last_gap_at = input.at;
      status.reason = input.reason;
      if (input.paused) status.status = "paused";
      invalidate((fact) => fact.evidence?.source === "push", "gap");
      return;
    }
    if (input.kind === "expire") {
      for (const [key, deadline] of Object.entries(state.deadlines)) {
        if (deadline > input.tick) continue;
        const fact = draft.latest[key];
        delete state.deadlines[key];
        if (fact?.reason === "current") {
          fact.reason = "expired";
          fact.rule_eligible = false;
          fact.expires_at = null;
        }
      }
      return;
    }
    if (input.kind === "configure") {
      status.policy_version = input.policy_version;
      const supported = new Set(input.supported);
      for (const [key, device] of Object.entries(draft.device)) {
        if (!draft.device_coverage[key])
          draft.device_coverage[key] = {
            account_id: device.account_id,
            device_id: device.id,
            source_id: null,
            collection_generation: null,
            properties: supported.has(device.id) ? "pending" : "unsupported",
            online: supported.has(device.id) ? "pending" : "unsupported",
            reason: supported.has(device.id) ? null : "unsupported_device_id",
            independent_events: "unsupported",
          };
        device.read_enabled_properties = input.definitions
          .filter(
            (item) =>
              item.device.id === device.id &&
              item.policy?.read !== false &&
              item.capability?.readable,
          )
          .map(({ siid, piid }) => ({ siid, piid }));
      }
      for (const definition of input.definitions) {
        const key = propertyKey(
          definition.device.account_id,
          definition.device.id,
          definition.siid,
          definition.piid,
        );
        const prior = draft.latest[key];
        const empty = emptyProperty(definition);
        const next = prior
          ? {
              ...prior,
              spec_id: empty.spec_id,
              description: empty.description,
              type_name: empty.type_name,
              service_type_name: empty.service_type_name,
              unit: empty.unit,
              readable: empty.readable,
              room_id: empty.room_id,
            }
          : empty;
        const bytes =
          state.latest_bytes -
          (prior ? jsonBytes(prior) : -jsonBytes(key) - 2) +
          jsonBytes(next);
        if (
          (!prior &&
            Object.keys(draft.latest).length >= collectionLimits.properties) ||
          bytes > collectionLimits.latestBytes
        ) {
          status.capacity_degraded = true;
          continue;
        }
        draft.latest[key] = next;
        state.latest_bytes = bytes;
      }
      return;
    }
    const event = input.event;
    if (!account) return;
    if (event.kind === "connection") {
      const old = draft.source_health[event.source_id];
      if (
        event.status === "closed" &&
        old &&
        old.collection_generation !== event.collection_generation
      )
        return;
      draft.source_health[event.source_id] = {
        source_id: event.source_id,
        collection_generation: event.collection_generation,
        status: event.status,
        reason: event.reason,
        updated_at: event.received_at,
      };
      if (
        event.status !== "connected" ||
        (old && old.collection_generation !== event.collection_generation)
      ) {
        invalidate(
          (fact) =>
            fact.evidence?.source === "push" &&
            fact.evidence.source_id === event.source_id,
          "disconnected",
        );
        for (const coverage of Object.values(draft.device_coverage))
          if (coverage.source_id === event.source_id) {
            coverage.properties = "pending";
            coverage.online = "pending";
            coverage.collection_generation = event.collection_generation;
          }
      }
      return;
    }
    const deviceKey = entityKey(account, event.did);
    const device = draft.device[deviceKey];
    if (!device || device.archived) return;
    const coverage = draft.device_coverage[deviceKey];
    const source = draft.source_health[event.source_id];
    if (
      event.kind !== "read" &&
      (!source || source.collection_generation !== event.collection_generation)
    )
      return;
    if (event.kind === "subscription") {
      if (!coverage) return;
      coverage.source_id = event.source_id;
      coverage.collection_generation = event.collection_generation;
      coverage[event.channel] = event.status;
      coverage.reason = event.reason;
      if (event.status !== "confirmed") {
        if (event.channel === "properties")
          invalidate(
            (fact) =>
              fact.device_id === event.did && fact.evidence?.source === "push",
            event.status === "failed"
              ? "subscription_failed"
              : "subscription_pending",
          );
      }
      return;
    }
    if (event.kind === "online") {
      status.accepted++;
      const usable =
        source?.status === "connected" && event.delivery_kind === "live";
      if (usable) {
        device.online = event.online;
        state.online_updates = {
          ...state.online_updates,
          [deviceKey]: sequence,
        };
        if (!event.online)
          invalidate(
            (fact) =>
              fact.device_id === event.did && fact.evidence?.source === "push",
            "offline",
          );
      }
      accepted.observation = {
        event,
        observation_id: input.observation_id,
        input_sequence: sequence,
      };
      return;
    }
    const definition = input.definition;
    if (!definition) return;
    const key = propertyKey(account, event.did, event.siid, event.piid);
    const prior = projection.latest[key];
    const fact = prior ? { ...prior } : emptyProperty(definition);
    const ignored =
      event.kind === "property" &&
      (event.delivery_kind === "replayed" ||
        event.delivery_kind === "unknown" ||
        (event.delivery_kind === "baseline" && fact.has_value) ||
        (event.observed_at !== null &&
          prior?.evidence?.observed_at != null &&
          Date.parse(event.observed_at) <
            Date.parse(prior.evidence.observed_at)));
    const capabilityMatch = definition.capability
      ? matchesCapability(event.value, definition.capability)
      : "unknown";
    if (
      jsonBytes(event.value) > collectionLimits.valueBytes ||
      capabilityMatch === "invalid"
    ) {
      status.rejected++;
      if (prior && event.kind !== "read" && !ignored) {
        draft.latest[key] = {
          ...prior,
          reason: "invalid_value",
          rule_eligible: false,
          expires_at: null,
        };
        delete state.deadlines[key];
      }
      receipt = {
        outcome: "failed",
        reason: "invalid_value",
        observation_id: null,
      };
      return;
    }
    let reason: Latest["reason"] = "unverified";
    const policy = definition.policy;
    if (capabilityMatch === "unknown") reason = "spec_unknown";
    else if (event.kind === "read") reason = "cloud_cache";
    else if (event.delivery_kind !== "live") reason = "baseline";
    else if (source?.status !== "connected") reason = "disconnected";
    else if (coverage?.properties !== "confirmed")
      reason = "subscription_pending";
    else if (!device.online) reason = "offline";
    else if (policy?.verified_push && policy.freshness.mode !== "unknown")
      reason = "current";
    if (
      reason === "current" &&
      policy?.freshness.mode === "ttl" &&
      input.tick + policy.freshness.max_age_ms <= clock.tick
    )
      reason = "expired";
    const evidence = {
      observation_id: input.observation_id,
      input_sequence: sequence,
      source_id: event.source_id,
      collection_generation: event.collection_generation,
      source: event.kind === "read" ? ("read" as const) : ("push" as const),
      delivery_kind:
        event.kind === "read" ? ("baseline" as const) : event.delivery_kind,
      observed_at: event.observed_at,
      received_at: event.received_at,
      read_started_at: event.kind === "read" ? event.read_started_at : null,
      policy_version: definition.policy_version,
      spec_id: device.spec_id,
    };
    const candidate = event.kind === "read" && fact.has_value;
    if (ignored) {
      status.accepted++;
      accepted.observation = {
        event,
        observation_id: input.observation_id,
        input_sequence: sequence,
      };
      return;
    }
    if (candidate) {
      fact.last_read_at = event.received_at;
      fact.read_candidate = { ...evidence, value: event.value };
    } else {
      const continuous =
        prior?.reason === "current" &&
        (state.deadlines[key] === undefined ||
          state.deadlines[key] > input.tick) &&
        prior.evidence?.source === "push" &&
        prior.evidence.collection_generation === event.collection_generation &&
        reason === "current" &&
        event.kind === "property" &&
        event.delivery_kind === "live";
      Object.assign(fact, {
        has_value: true,
        value: event.value,
        evidence,
        reason,
        rule_eligible: reason === "current" && policy?.rule_eligible === true,
        spec_id: device.spec_id,
        applied_at: clock.at,
        expires_at: null,
        last_report_at:
          event.kind === "property" ? event.received_at : fact.last_report_at,
        last_read_at:
          event.kind === "read" ? event.received_at : fact.last_read_at,
      });
      delete state.deadlines[key];
      if (reason === "current" && policy?.freshness.mode === "ttl") {
        state.deadlines[key] = input.tick + policy.freshness.max_age_ms;
        fact.expires_at = new Date(
          Date.parse(event.received_at) + policy.freshness.max_age_ms,
        ).toISOString();
      }
      if (continuous && prior.value !== fact.value) {
        fact.last_change_at = event.received_at;
        edges.push({ key, before: prior, after: fact });
      }
    }
    const bytes =
      state.latest_bytes -
      (prior ? jsonBytes(prior) : -jsonBytes(key) - 2) +
      jsonBytes(fact);
    if (
      (!prior &&
        Object.keys(projection.latest).length >= collectionLimits.properties) ||
      bytes > collectionLimits.latestBytes
    ) {
      status.rejected++;
      status.capacity_degraded = true;
      edges.length = 0;
      if (event.kind !== "read") delete state.deadlines[key];
      if (prior && event.kind !== "read")
        draft.latest[key] = {
          ...prior,
          reason: "capacity",
          rule_eligible: false,
          expires_at: null,
        };
      receipt = {
        outcome: "failed",
        reason: "capacity",
        observation_id: null,
      };
      return;
    }
    draft.latest[key] = fact;
    state.latest_bytes = bytes;
    status.accepted++;
    receipt = {
      outcome: candidate ? "candidate" : "applied",
      reason,
      observation_id: input.observation_id,
    };
    accepted.observation = {
      event,
      observation_id: input.observation_id,
      input_sequence: sequence,
    };
  });
  // Control transitions can alter many records; property reports only account for their own delta.
  if (
    input.kind !== "observe" ||
    (input.event.kind !== "property" && input.event.kind !== "read") ||
    receipt.outcome === "failed"
  )
    state.latest_bytes = jsonBytes(output.latest);
  return {
    projection: output,
    state,
    receipt,
    observation: accepted.observation,
    edges,
  };
}
