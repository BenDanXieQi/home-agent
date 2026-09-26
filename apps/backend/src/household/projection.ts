import {
  projectionSchema,
  directorySchema,
  entityKey,
  changeSchema,
} from "@home-agent/api/household";
import type { Projection } from "@home-agent/api/household";
import type { deviceDirectory } from "../mijia/devices/directory";

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
        account_id: null,
        home_id: null,
        status: "unbound",
        stage: "account",
        homes: { selectedHomeId: null, status: "unselected", items: [] },
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
    spec: {},
    latest: {},
    source_health: {},
    rule_status: {},
  });
}
export function publicDirectory(
  candidate: ReturnType<typeof deviceDirectory>,
  now: string,
) {
  const home = candidate.homes.find((item) => item.id === candidate.homeId);
  const account_id = candidate.accountId;
  return directorySchema.parse({
    home: home
      ? {
          [entityKey(account_id, home.id)]: {
            account_id,
            home_id: home.id,
            name: home.name,
            shared: home.shared,
            last_seen_at: now,
            archived: false,
          },
        }
      : {},
    room: Object.fromEntries(
      (home?.rooms ?? []).map((room) => [
        entityKey(account_id, home!.id, room.id),
        {
          account_id,
          home_id: home!.id,
          room_id: room.id,
          name: room.name,
          last_seen_at: now,
          archived: false,
        },
      ]),
    ),
    device: Object.fromEntries(
      candidate.devices.map((device) => [
        entityKey(account_id, device.id),
        {
          ...device,
          account_id,
          device_id: device.id,
          spec_id: null,
          category: null,
          capability_tags: [],
          availability: "unknown",
          read_enabled_properties: [],
          alias: null,
          last_seen_at: now,
          archived: false,
        },
      ]),
    ),
  });
}
export function projectionChanges(previous: Projection, next: Projection) {
  const changes = [];
  for (const entity of projectionSchema.keyof().options) {
    const before: Record<string, unknown> = previous[entity];
    const after: Record<string, unknown> = next[entity];
    for (const key of Object.keys(before))
      if (!(key in after))
        changes.push(changeSchema.parse({ op: "remove", entity, key }));
    for (const [key, value] of Object.entries(after))
      if (
        before[key] !== value &&
        JSON.stringify(before[key]) !== JSON.stringify(value)
      )
        changes.push(changeSchema.parse({ op: "upsert", entity, key, value }));
  }
  return changes;
}
