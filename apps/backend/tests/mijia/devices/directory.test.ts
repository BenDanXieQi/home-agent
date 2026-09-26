import { describe, expect, test } from "bun:test";
import { deviceDirectory } from "../../../src/mijia/devices/directory";

function catalog() {
  return {
    homes: [
      {
        id: "home-a",
        name: "Home A",
        shared: false,
        deviceIds: ["a"],
        rooms: [{ id: "room-a", name: "Room A", deviceIds: ["a"] }],
      },
    ],
    devices: [
      {
        did: "a",
        model: "test.sensor.model",
        name: "Sensor",
        isOnline: false,
        home_id: "home-a",
        home_name: "Home A",
        room_id: "room-a",
        room_name: "Room A",
        token: "never-public",
        localip: "192.0.2.1",
        password: "never-public",
        spec_type: "urn:test:device:sensor:1",
      },
      { did: "b", model: "test.sensor.model", home_id: "home-b" },
    ],
  } satisfies Parameters<typeof deviceDirectory>[0];
}

describe("household directory projection", () => {
  test("only projects the selected household and never leaks vendor access material", () => {
    const result = deviceDirectory(catalog(), "account-a", "home-a");
    expect(result).toEqual({
      accountId: "account-a",
      homeId: "home-a",
      homes: [
        {
          id: "home-a",
          name: "Home A",
          shared: false,
          rooms: [{ id: "room-a", name: "Room A" }],
        },
      ],
      devices: [
        {
          id: "a",
          name: "Sensor",
          model: "test.sensor.model",
          home_id: "home-a",
          home_name: "Home A",
          room_id: "room-a",
          room_name: "Room A",
          online: false,
          camera: false,
          channels: [],
          spec_type: "urn:test:device:sensor:1",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("never-public");
    expect(JSON.stringify(result)).not.toContain("192.0.2.1");
  });

  test("no selected household grants no devices from a catalog", () => {
    expect(deviceDirectory(catalog(), "account-a", null).devices).toEqual([]);
  });
});
