import { isDeepStrictEqual } from "node:util";
import {
  changeSchema,
  upsertChangeSchema,
  projectionSchema,
} from "@home-agent/api/household";
import type { Projection } from "@home-agent/api/household";
import { isImmutable, parseImmutable, update } from "@home-agent/api/immutable";
import { householdLimits, jsonBytes } from "./config";

const entities = projectionSchema.keyof().options;
const validated = new WeakMap<
  object,
  ReturnType<typeof upsertChangeSchema.parse>
>();

export function initialProjectionState(projection: Projection) {
  return { projection: parseImmutable(projectionSchema, projection) };
}

/** Validate changed records once and preserve untouched immutable references. */
export function prepareProjection(
  state: ReturnType<typeof initialProjectionState>,
  candidate: Projection,
) {
  const changes: ReturnType<typeof changeSchema.parse>[] = [];
  const projection = update(state.projection, (draft) => {
    for (const entity of entities) {
      if (state.projection[entity] === candidate[entity]) continue;
      const records: Record<string, unknown> = { ...state.projection[entity] };
      const incoming: Record<string, unknown> = candidate[entity];
      for (const key of Object.keys(records)) {
        if (Object.hasOwn(incoming, key)) continue;
        changes.push(changeSchema.parse({ op: "remove", entity, key }));
        delete records[key];
      }
      let changed =
        Object.keys(records).length !==
        Object.keys(state.projection[entity]).length;
      for (const [key, value] of Object.entries(incoming)) {
        if (records[key] === value || isDeepStrictEqual(records[key], value))
          continue;
        const input =
          value !== null && typeof value === "object" && isImmutable(value)
            ? value
            : undefined;
        const cached = input ? validated.get(input) : undefined;
        const change =
          cached?.entity === entity && cached.key === key
            ? cached
            : parseImmutable(upsertChangeSchema, {
                op: "upsert",
                entity,
                key,
                value,
              });
        if (input) validated.set(input, change);
        Object.defineProperty(records, key, {
          value: change.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        changes.push(change);
        changed = true;
      }
      if (changed) Object.assign(draft, { [entity]: records });
    }
  });
  return { projection, changes: update(changes, () => {}) };
}

/** Admission belongs to directory acquisition, never lifecycle transitions. */
export function directoryFits(
  directory: Pick<Projection, "home" | "room" | "device">,
) {
  return (
    Object.keys(directory.device).length <= householdLimits.devices &&
    jsonBytes(directory) <= householdLimits.directoryBytes
  );
}

/** Diagnostics are sampled on request, not maintained as a second state ledger. */
export function projectionBytes(projection: Projection) {
  const { home, room, device, ...metadata } = projection;
  return {
    directory: jsonBytes({ home, room, device }),
    metadata: jsonBytes(metadata),
    projection: jsonBytes(projection),
  };
}
