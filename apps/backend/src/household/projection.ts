import { isDeepStrictEqual } from "node:util";
import {
  changeSchema,
  upsertChangeSchema,
  projectionSchema,
  type Projection,
} from "@home-agent/api/household";
import { isImmutable, parseImmutable, update } from "@home-agent/api/immutable";

export function initialProjection() {
  return projectionSchema.parse({
    account: { account: { status: "idle" } },
    login: {
      login: { id: null, status: "idle", error: null, material_version: 0 },
    },
    connection: { connection: null },
    media: {
      media: { revision: crypto.randomUUID(), binding: { status: "unbound" } },
    },
    household: {
      household: {
        provider: null,
        account_id: null,
        home_id: null,
        status: "unbound",
        stage: "account",
        homes: { selectedHomeId: null, status: "unselected" },
        sync_status: "unsynced",
        cloud_synced_at: null,
        saved_at: null,
        error: null,
      },
    },
    projection_health: {
      projection_health: { storage_degraded: false, capacity_degraded: false },
    },
    home: {},
    room: {},
    device: {},
  });
}

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
