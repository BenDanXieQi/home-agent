import {
  deviceSchema,
  entityKey,
  initialSpecification,
  snapshotSchema,
} from "@home-agent/api/household";

export const epoch = "a1000000-0000-4000-8000-000000000001";
export const otherEpoch = "a1000000-0000-4000-8000-000000000002";
export const accountId = "a2000000-0000-4000-8000-000000000001";
export const mediaRevision = "a3000000-0000-4000-8000-000000000001";
export const loginId = "a4000000-0000-4000-8000-000000000001";
export const playbackId = "a5000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-01T00:00:00.000Z";

export function householdSnapshot() {
  return snapshotSchema.parse({
    scope_epoch: epoch,
    sequence: 1,
    projection: {
      account: {
        account: { status: "authenticated", id: accountId, profile: null },
      },
      login: {
        login: { id: null, status: "idle", error: null, material_version: 0 },
      },
      connection: { connection: null },
      media: {
        media: { revision: mediaRevision, binding: { status: "ready" } },
      },
      household: {
        household: {
          provider: "mijia",
          account_id: accountId,
          home_id: "home-1",
          status: "running",
          stage: "ready",
          homes: {
            selectedHomeId: "home-1",
            status: "selected",
          },
          sync_status: "synced",
          cloud_synced_at: timestamp,
          saved_at: timestamp,
          error: null,
        },
      },
      projection_health: {
        projection_health: {
          storage_degraded: false,
          capacity_degraded: false,
        },
      },
      home: {},
      room: {},
      device: {},
    },
  });
}

export function device(
  overrides: Partial<ReturnType<typeof deviceSchema.parse>> = {},
) {
  return deviceSchema.parse({
    id: "device-1",
    device_id: "device-1",
    account_id: accountId,
    name: "客厅灯",
    alias: null,
    model: "test.light.v1",
    home_id: "home-1",
    home_name: "家",
    room_id: null,
    room_name: null,
    online: true,
    camera: false,
    channels: [],
    ...initialSpecification,
    last_seen_at: timestamp,
    archived: false,
    category: null,
    capability_tags: [],
    availability: "unknown",
    read_enabled_properties: [],
    ...overrides,
  });
}

export function withDevices(...devices: ReturnType<typeof device>[]) {
  const snapshot = householdSnapshot();
  snapshot.projection.device = Object.fromEntries(
    devices.map((item) => [entityKey(item.account_id, item.device_id), item]),
  );
  return snapshot;
}

export function commandResult(scope_epoch = epoch, sequence = 1) {
  return { state_version: { scope_epoch, sequence } };
}

/** Fresh private command atoms and the production appStore; no React renderer. */
export async function loadMijiaState() {
  const [{ appStore }, atoms, state] = await Promise.all([
    import("../../src/lib/store"),
    import("../../src/features/mijia/household-state"),
    import("../../src/features/mijia/state"),
  ]);
  return { appStore, ...atoms, ...state };
}
