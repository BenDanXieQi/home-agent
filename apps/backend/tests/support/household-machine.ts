import { createActor, type ActorRefFrom } from "xstate";
import { deviceSchema, entityKey } from "@home-agent/api/household";
import { householdMachine } from "../../src/household/machine";
import { initialProjection } from "../../src/household/projection";
import type { HouseholdSourceState } from "../../src/household/source";

const timestamp = "2026-09-01T00:00:00.000Z";
const accountId = '["cn","100001"]';
const homes = [
  { id: "home-a", name: "Home A", shared: false },
  { id: "home-b", name: "Home B", shared: true },
];

export function machineSource() {
  const projection = initialProjection();
  return {
    provider: "mijia",
    account_id: accountId,
    account: {
      status: "authenticated" as const,
      id: "a2000000-0000-4000-8000-000000000001",
      profile: null,
    },
    login: projection.login.login,
    connection: projection.connection.connection,
    media: projection.media.media,
    homes: {
      selectedHomeId: "home-a",
      status: "selected" as const,
      items: homes,
    },
    directory_sync: "unsynced" as const,
    directory_error: null,
    directory_capacity: false,
    directory_storage: false,
  } satisfies HouseholdSourceState;
}

export function machineDirectory(account_id = accountId, home_id = "home-a") {
  const device = deviceSchema.parse({
    id: "device-a",
    device_id: "device-a",
    account_id,
    name: "Sensor",
    model: "test.sensor.contract",
    home_id,
    home_name: "Home A",
    room_id: null,
    room_name: null,
    online: true,
    camera: false,
    channels: [],
    spec_id: null,
    spec_status: "loading",
    spec_error: null,
    last_seen_at: timestamp,
    archived: false,
    alias: null,
    category: null,
    capability_tags: [],
    availability: "unknown",
    read_enabled_properties: [],
  });
  return {
    home: {
      [entityKey(account_id, home_id)]: {
        account_id,
        home_id,
        name: "Home A",
        shared: false,
        last_seen_at: timestamp,
        archived: false,
      },
    },
    room: {},
    device: { [entityKey(account_id, device.device_id)]: device },
  };
}

export function commitMachineDirectory(
  actor: ActorRefFrom<typeof householdMachine>,
  home_id: string | null = "home-a",
) {
  const { projection, scope_epoch } = actor.getSnapshot().context;
  const account_id = projection.household.household.account_id;
  if (!account_id) throw new Error("Directory fixture needs an account");
  actor.send({
    type: "directory",
    scope_epoch,
    projection: {
      ...projection,
      ...(home_id
        ? machineDirectory(account_id, home_id)
        : { home: {}, room: {}, device: {} }),
      household: {
        household: {
          ...projection.household.household,
          home_id,
          homes: {
            selectedHomeId: home_id,
            status: home_id ? "selected" : "unselected",
          },
        },
      },
    },
  });
}

export function runningMachine() {
  const actor = createActor(householdMachine).start();
  const source = machineSource();
  actor.send({ type: "source", state: source });
  commitMachineDirectory(actor);
  return { actor, source };
}
