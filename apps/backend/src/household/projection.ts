import { projectionSchema } from "@home-agent/api/household";

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
