import type {
  agentContextDataSchemas,
  agentObservationSourceSchema,
} from "@home-agent/api/agent-context";
import { isDeepStrictEqual } from "node:util";
import { createAgentDeviceMetadata } from "@home-agent/api/agent-context/devices";
import type { agentReceiptSchema } from "@home-agent/api/agent-receipts";
import { agentReceiptChangeSchema } from "@home-agent/api/agent-receipts";
import type { z } from "zod";

function collectionState(
  value: z.infer<
    typeof agentContextDataSchemas.device_state
  >["collection"]["collection"],
) {
  const { accepted: _accepted, ...state } = value;
  return state;
}
function observationSourceState(
  value: z.infer<typeof agentObservationSourceSchema>,
) {
  const { read_at: _readAt, ...state } = value;
  return state;
}

/** Capture structured differences while both accepted contexts are available. */
export function receiptChanges(
  input: Pick<z.infer<typeof agentReceiptSchema>, "message" | "context">,
  previous: z.infer<typeof agentReceiptSchema>["context"] | null,
) {
  const changes: z.infer<typeof agentReceiptChangeSchema>[] = [];
  const before = previous?.parts;
  const after = input.context.parts;
  const oldDevice = before?.device_state;
  const newDevice = after.device_state;
  const publication = input.message.data.parts.device_state;
  if (publication && newDevice?.status === "ready") {
    const oldMetadata = createAgentDeviceMetadata(before?.household);
    const newMetadata = createAgentDeviceMetadata(after.household);
    const oldLatest =
      oldDevice?.status === "ready" ? oldDevice.data.latest : {};
    const keys =
      publication.status === "delta"
        ? [
            ...new Set(
              publication.data.changes
                .filter((c) => c.entity === "latest")
                .map((c) => c.key),
            ),
          ]
        : [
            ...new Set([
              ...Object.keys(oldLatest),
              ...Object.keys(newDevice.data.latest),
            ]),
          ];
    for (const key of keys) {
      const old = oldLatest[key];
      const next = newDevice.data.latest[key];
      if (isDeepStrictEqual(old, next)) continue;
      const identity = next ?? old;
      if (!identity) continue;
      changes.push({
        kind: "property",
        key,
        metadata: (next ? newMetadata : oldMetadata).property(identity),
        before: old ?? null,
        after: next ?? null,
      });
    }
    const oldOnline = new Map(
      oldDevice?.status === "ready"
        ? oldDevice.data.online.map((d) => [
            JSON.stringify([d.account_id, d.device_id]),
            d,
          ])
        : [],
    );
    for (const next of newDevice.data.online) {
      const key = JSON.stringify([next.account_id, next.device_id]);
      const old = oldOnline.get(key);
      oldOnline.delete(key);
      if (old?.online !== next.online)
        changes.push({
          kind: "online",
          key,
          metadata: newMetadata.device(next),
          before: old?.online ?? null,
          after: next.online,
        });
    }
    for (const [key, old] of oldOnline)
      changes.push({
        kind: "online",
        key,
        metadata: oldMetadata.device(old),
        before: old.online,
        after: null,
      });
    const oldHealth =
      oldDevice?.status === "ready" ? oldDevice.data.source_health : {};
    for (const key of new Set([
      ...Object.keys(oldHealth),
      ...Object.keys(newDevice.data.source_health),
    ])) {
      const old = oldHealth[key];
      const next = newDevice.data.source_health[key];
      const prior = old
        ? {
            source_id: old.source_id,
            collection_generation: old.collection_generation,
            status: old.status,
            reason: old.reason,
          }
        : null;
      const current = next
        ? {
            source_id: next.source_id,
            collection_generation: next.collection_generation,
            status: next.status,
            reason: next.reason,
          }
        : null;
      if (!isDeepStrictEqual(prior, current))
        changes.push({
          kind: "source_health",
          key,
          before: prior,
          after: current,
        });
    }
    const oldCoverage =
      oldDevice?.status === "ready" ? oldDevice.data.device_coverage : {};
    for (const key of new Set([
      ...Object.keys(oldCoverage),
      ...Object.keys(newDevice.data.device_coverage),
    ])) {
      const old = oldCoverage[key];
      const next = newDevice.data.device_coverage[key];
      const identity = next ?? old;
      if (!identity || isDeepStrictEqual(old, next)) continue;
      changes.push({
        kind: "device_coverage",
        key,
        metadata: (next ? newMetadata : oldMetadata).device(identity),
        before: old ?? null,
        after: next ?? null,
      });
    }
    const old =
      oldDevice?.status === "ready"
        ? oldDevice.data.collection.collection
        : undefined;
    const next = newDevice.data.collection.collection;
    const prior = old ? collectionState(old) : null;
    const current = collectionState(next);
    if (!isDeepStrictEqual(prior, current))
      changes.push({
        kind: "collection",
        key: "collection",
        before: prior,
        after: current,
      });
  }
  const observations = input.message.data.parts.observations;
  if (observations?.status === "ready") {
    const old = before?.observations;
    const records = new Map(
      old?.status === "ready" ? old.data.records.map((r) => [r.id, r]) : [],
    );
    for (const next of observations.data.records) {
      const prior = records.get(next.id);
      records.delete(next.id);
      if (!isDeepStrictEqual(prior, next))
        changes.push({
          kind: "observation",
          key: next.id,
          before: prior ?? null,
          after: next,
        });
    }
    for (const [key, prior] of records)
      changes.push({ kind: "observation", key, before: prior, after: null });
    for (const key of ["member_sightings", "perception"] as const) {
      const prior =
        old?.status === "ready"
          ? observationSourceState(old.data.sources[key])
          : null;
      const current = observationSourceState(observations.data.sources[key]);
      if (!isDeepStrictEqual(prior, current))
        changes.push({
          kind: "observation_source",
          key,
          before: prior,
          after: current,
        });
    }
  }
  const members = input.message.data.parts.members;
  if (members?.status === "ready") {
    const old = before?.members;
    const records = new Map(
      old?.status === "ready" ? old.data.members.map((r) => [r.id, r]) : [],
    );
    for (const next of members.data.members) {
      const prior = records.get(next.id);
      records.delete(next.id);
      if (!isDeepStrictEqual(prior, next))
        changes.push({
          kind: "member",
          key: next.id,
          before: prior ?? null,
          after: next,
        });
    }
    for (const [key, prior] of records)
      changes.push({ kind: "member", key, before: prior, after: null });
  }
  const spatial = input.message.data.parts.spatial;
  if (spatial?.status === "ready") {
    const old = before?.spatial;
    function compare(
      kind: "space" | "passage",
      prior: { id: string }[],
      current: { id: string }[],
    ) {
      const records = new Map(prior.map((record) => [record.id, record]));
      for (const next of current) {
        const priorRecord = records.get(next.id);
        records.delete(next.id);
        if (!isDeepStrictEqual(priorRecord, next))
          changes.push(
            agentReceiptChangeSchema.parse({
              kind,
              key: next.id,
              before: priorRecord ?? null,
              after: next,
            }),
          );
      }
      for (const [key, priorRecord] of records)
        changes.push(
          agentReceiptChangeSchema.parse({
            kind,
            key,
            before: priorRecord,
            after: null,
          }),
        );
    }
    compare(
      "space",
      old?.status === "ready" ? old.data.spaces : [],
      spatial.data.spaces,
    );
    compare(
      "passage",
      old?.status === "ready" ? old.data.passages : [],
      spatial.data.passages,
    );
    function bindingNames(context: typeof before) {
      const spatialPart = context?.spatial;
      const householdPart = context?.household;
      const devices = new Map(
        householdPart?.status === "ready"
          ? Object.values(householdPart.data.device).map((device) => [
              device.id,
              device.name,
            ])
          : [],
      );
      const spaces = new Map(
        spatialPart?.status === "ready"
          ? spatialPart.data.spaces.map((record) => [record.id, record.name])
          : [],
      );
      const passages = new Map(
        spatialPart?.status === "ready"
          ? spatialPart.data.passages.map((record) => [record.id, record.name])
          : [],
      );
      return (
        binding:
          | z.infer<
              typeof agentContextDataSchemas.spatial
            >["observation_bindings"][number]
          | null,
      ) =>
        binding
          ? {
              device_name: devices.get(binding.device_id) ?? null,
              target_name:
                (binding.space_id !== null
                  ? spaces.get(binding.space_id)
                  : passages.get(binding.passage_id ?? "")) ?? null,
            }
          : null;
    }
    const oldNames = bindingNames(before);
    const newNames = bindingNames(after);
    const bindings = new Map(
      old?.status === "ready"
        ? old.data.observation_bindings.map((binding) => [binding.id, binding])
        : [],
    );
    for (const next of spatial.data.observation_bindings) {
      const prior = bindings.get(next.id) ?? null;
      bindings.delete(next.id);
      if (!isDeepStrictEqual(prior, next))
        changes.push({
          kind: "observation_binding",
          key: next.id,
          before: prior,
          after: next,
          metadata: { before: oldNames(prior), after: newNames(next) },
        });
    }
    for (const [key, prior] of bindings)
      changes.push({
        kind: "observation_binding",
        key,
        before: prior,
        after: null,
        metadata: { before: oldNames(prior), after: null },
      });
  }
  const household = input.message.data.parts.household;
  if (household?.status === "ready") {
    const old = before?.household;
    const devices = new Map(
      old?.status === "ready"
        ? Object.values(old.data.device).map((d) => [d.id, d])
        : [],
    );
    for (const next of Object.values(household.data.device)) {
      const prior = devices.get(next.id);
      devices.delete(next.id);
      if (!isDeepStrictEqual(prior, next))
        changes.push({
          kind: "inventory_device",
          key: next.id,
          before: prior ?? null,
          after: next,
        });
    }
    for (const [key, prior] of devices)
      changes.push({
        kind: "inventory_device",
        key,
        before: prior,
        after: null,
      });
    for (const key of ["household", "home", "room", "specs"] as const) {
      if (
        !isDeepStrictEqual(
          old?.status === "ready" ? old.data[key] : undefined,
          household.data[key],
        )
      )
        changes.push({
          kind: "household_metadata",
          key,
          initial: old?.status !== "ready",
        });
    }
  }
  for (const key of [
    "household",
    "spatial",
    "device_state",
    "members",
    "observations",
  ] as const) {
    const next = input.message.data.parts[key];
    const old = before?.[key];
    if (next && next.status !== "ready" && next.status !== "delta")
      changes.push({
        kind: "availability",
        key,
        before: old ? { status: old.status, reason: old.reason } : null,
        after: { status: next.status, reason: next.reason },
      });
  }
  return changes;
}
