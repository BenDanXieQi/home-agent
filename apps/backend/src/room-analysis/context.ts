import { createHash } from "node:crypto";
import { selectRoomFacts } from "@home-agent/api/household";
import {
  propertyKey,
  type latestPropertySchema,
} from "@home-agent/api/observations";
import {
  roomAnalysisLimits,
  roomContextSchema,
  type analysisChangeSchema,
} from "@home-agent/api/room-analysis";
import type { z } from "zod";

export const analysisPolicyVersion = "room-context-2026-09-28";
const discrete = new Set([
  "on",
  "status",
  "mode",
  "occupancy",
  "occupancy-status",
  "someone-exists",
  "motion-state",
  "motion-detection",
  "door-state",
  "contact-state",
  "current-position",
  "target-position",
  "food-storage-status",
  "feeding-state",
  "fault",
]);
const numeric = new Map([
  ["temperature", { delta: 1, unit: "celsius" }],
  ["target-temperature", { delta: 1, unit: "celsius" }],
  ["relative-humidity", { delta: 5, unit: "percentage" }],
  ["illumination", { delta: 30, unit: "lux" }],
  ["brightness", { delta: 10, unit: "percentage" }],
  ["color-temperature", { delta: 300, unit: "kelvin" }],
  ["pm2.5-density", { delta: 15, unit: "μg/m3" }],
  ["co2-density", { delta: 100, unit: "ppm" }],
]);

export function relevantProperty(fact: z.infer<typeof latestPropertySchema>) {
  return (
    fact.type_name !== null &&
    (discrete.has(fact.type_name) || numeric.has(fact.type_name))
  );
}
export function canTrigger(fact: z.infer<typeof latestPropertySchema>) {
  if (
    !relevantProperty(fact) ||
    !fact.has_value ||
    !fact.rule_eligible ||
    fact.reason !== "current"
  )
    return false;
  if (typeof fact.value === "string" && fact.value.length > 256) return false;
  const threshold = numeric.get(fact.type_name!);
  return (
    !threshold ||
    (typeof fact.value === "number" && fact.unit === threshold.unit)
  );
}
export function meaningfulChange(
  baseline: z.infer<typeof latestPropertySchema>["value"],
  fact: Pick<
    z.infer<typeof latestPropertySchema>,
    "value" | "type_name" | "unit"
  >,
) {
  if (baseline === fact.value) return false;
  const threshold = numeric.get(fact.type_name ?? "");
  // Only apply a numeric tolerance when both values have the expected unit.
  // A type/unit/source change must not be mistaken for insignificant noise.
  if (
    !threshold ||
    fact.unit !== threshold.unit ||
    typeof baseline !== "number" ||
    typeof fact.value !== "number"
  )
    return true;
  const precision =
    Number.EPSILON * Math.max(1, Math.abs(baseline), Math.abs(fact.value)) * 4;
  return Math.abs(fact.value - baseline) + precision >= threshold.delta;
}
export const jsonBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value));

export function factMetadata(fact: z.infer<typeof latestPropertySchema>) {
  return JSON.stringify([
    fact.room_id,
    fact.spec_id,
    fact.has_value,
    fact.reason,
    fact.rule_eligible,
    fact.description,
    fact.type_name,
    fact.service_type_name,
    fact.unit,
    fact.evidence?.source_id,
    fact.evidence?.collection_generation,
    fact.evidence?.policy_version,
    fact.evidence?.delivery_kind,
    fact.evidence?.observed_at != null,
  ]);
}

export function factMeaning(fact: z.infer<typeof latestPropertySchema>) {
  return JSON.stringify([factMetadata(fact), fact.value]);
}

/** Keep the analyzed values as fixed baselines; receipt times do not move them. */
export function roomDependencies(
  snapshot: Parameters<typeof selectRoomFacts>[0],
  roomId: string | null,
) {
  const facts = selectRoomFacts(snapshot, { room_id: roomId, limit: 2000 });
  const properties = facts.properties.filter(relevantProperty);
  const metadata = createHash("sha256")
    .update(
      JSON.stringify({
        scope: snapshot.scope_epoch,
        room: facts.room?.name,
        devices: facts.devices
          .toSorted((a, b) => a.id.localeCompare(b.id))
          .map((device) => [
            device.id,
            device.name,
            device.alias,
            device.spec_id,
            device.spec_status,
            device.online,
          ]),
        properties: properties.map((fact) => [
          propertyKey(fact.account_id, fact.device_id, fact.siid, fact.piid),
          factMetadata(fact),
        ]),
        truncated: facts.coverage.truncated,
      }),
    )
    .digest("hex");
  return {
    metadata,
    values: properties.map(({ value, type_name, unit }) => ({
      value,
      type_name,
      unit,
    })),
  };
}

/** Triggering and result validation share the same numeric noise thresholds. */
export function roomDependenciesChanged(
  baseline: ReturnType<typeof roomDependencies> | null,
  current: ReturnType<typeof roomDependencies>,
) {
  if (
    !baseline ||
    baseline.metadata !== current.metadata ||
    baseline.values.length !== current.values.length
  )
    return true;
  return current.values.some((fact, index) =>
    meaningfulChange(baseline.values[index]!.value, fact),
  );
}

export function buildRoomContext(
  snapshot: Parameters<typeof selectRoomFacts>[0],
  roomId: string | null,
  trigger: z.infer<typeof roomContextSchema>["trigger"],
  changes: z.infer<typeof analysisChangeSchema>[],
  changesTruncated: boolean,
  valueLabel: (
    did: string,
    siid: number,
    piid: number,
    value: z.infer<typeof latestPropertySchema>["value"],
  ) => string | null,
) {
  const view = selectRoomFacts(snapshot, { room_id: roomId, limit: 2000 });
  const devices = new Map(view.devices.map((device) => [device.id, device]));
  const relevant = view.properties.filter(relevantProperty);
  const changed = new Set(
    changes.map((item) =>
      JSON.stringify([item.device_id, item.siid, item.piid]),
    ),
  );
  const available = relevant.filter(
    (fact) =>
      devices.get(fact.device_id)?.online === true &&
      fact.has_value &&
      fact.evidence &&
      ["current", "unverified", "cloud_cache", "baseline"].includes(
        fact.reason,
      ) &&
      (typeof fact.value !== "string" || fact.value.length <= 256),
  );
  available.sort((a, b) => {
    const priority = (fact: typeof a) =>
      (changed.has(JSON.stringify([fact.device_id, fact.siid, fact.piid]))
        ? 4
        : 0) +
      (fact.reason === "current" ? 2 : 0) +
      (fact.type_name === "on" ? 1 : 0);
    return priority(b) - priority(a);
  });
  const context = roomContextSchema.parse({
    scope_epoch: snapshot.scope_epoch,
    room_id: roomId,
    room: (view.room?.name ?? "未分配房间").slice(0, 256),
    captured_at: new Date().toISOString(),
    policy_version: analysisPolicyVersion,
    trigger,
    changes,
    facts: available.slice(0, roomAnalysisLimits.facts).map((fact, index) => {
      const device = devices.get(fact.device_id)!;
      return {
        id: `f${index + 1}`,
        device_id: fact.device_id,
        device: (device.alias ?? device.name).slice(0, 256),
        online: device.online,
        siid: fact.siid,
        piid: fact.piid,
        property: fact.description.slice(0, 256),
        type: fact.type_name,
        service: fact.service_type_name,
        value: fact.value,
        value_label:
          valueLabel(fact.device_id, fact.siid, fact.piid, fact.value)?.slice(
            0,
            256,
          ) ?? null,
        unit: fact.unit,
        reason: fact.reason,
        observed_at: fact.evidence!.observed_at,
        received_at: fact.evidence!.received_at,
        expires_at: fact.expires_at,
        observation_id: fact.evidence!.observation_id,
      };
    }),
    coverage: {
      devices: view.devices.length,
      properties: view.coverage.properties,
      included: 0,
      missing: view.coverage.missing,
      excluded: view.properties.length - available.length,
      unconfirmed: 0,
      truncated:
        view.coverage.truncated || available.length > roomAnalysisLimits.facts,
      changes_truncated: changesTruncated,
      independent_events: "unsupported",
    },
  });
  while (
    jsonBytes(context) > roomAnalysisLimits.contextBytes &&
    context.facts.length
  ) {
    context.facts.pop();
    context.coverage.truncated = true;
  }
  while (
    jsonBytes(context) > roomAnalysisLimits.contextBytes &&
    context.changes.length
  ) {
    context.changes.shift();
    context.coverage.changes_truncated = true;
  }
  context.coverage.included = context.facts.length;
  context.coverage.unconfirmed = context.facts.filter(
    (fact) => fact.reason !== "current",
  ).length;
  return context;
}

// Property expiry belongs to HouseholdRuntime; the snapshot retains its original evidence.
export function contextExpired(
  context: z.infer<typeof roomContextSchema>,
  now = Date.now(),
) {
  return now >= Date.parse(context.captured_at) + roomAnalysisLimits.maxAgeMs;
}
