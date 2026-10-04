import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { householdSnapshotAtom } from "../../../src/modules/household/state";
import {
  deviceFilterAtom,
  deviceFilterOptionsAtom,
  deviceFiltersAtom,
  deviceSearchAtom,
  filteredDevicesAtom,
} from "../../../src/pages/devices/filters";
import {
  device,
  householdSnapshot,
  otherEpoch,
  withDevices,
} from "../../support/household";
import { fetchMock } from "../../support/http";

let store = createStore();

beforeEach(() => {
  store = createStore();
  store.set(householdSnapshotAtom, householdSnapshot());
});

describe("Device filtering", () => {
  it("filters by the latest device online report and searches normalized aliases", () => {
    const offline = device({ online: false });
    const online = device({
      id: "device-2",
      device_id: "device-2",
      online: true,
      alias: "Reading Light",
    });
    store.set(householdSnapshotAtom, withDevices(offline, online));
    store.set(deviceFilterAtom, "online");
    expect(store.get(filteredDevicesAtom)).toEqual([online]);
    store.set(deviceFilterAtom, "offline");
    expect(store.get(filteredDevicesAtom)).toEqual([offline]);
    store.set(deviceFilterAtom, "all");
    store.set(deviceSearchAtom, "  READING  ");
    expect(store.get(filteredDevicesAtom)).toEqual([online]);
  });

  it("combines room, category, and capability filters without changing household scope", () => {
    const light = device({
      room_id: "living",
      room_name: "客厅",
      category: "light",
      capability_tags: ["readable", "writeable"],
    });
    const sensor = device({
      id: "sensor",
      device_id: "sensor",
      room_id: "living",
      room_name: "客厅",
      category: "sensor",
      capability_tags: ["readable", "notify"],
    });
    const otherRoom = device({
      id: "other",
      device_id: "other",
      room_id: "bedroom",
      room_name: "卧室",
      category: "light",
      capability_tags: ["writeable"],
    });
    const snapshot = withDevices(light, sensor, otherRoom);
    store.set(householdSnapshotAtom, snapshot);
    store.set(deviceFiltersAtom, {
      room: JSON.stringify(["home-1", "living"]),
      category: JSON.stringify("light"),
      capability: "writeable",
    });
    expect(store.get(filteredDevicesAtom)).toEqual([light]);
    expect(store.get(householdSnapshotAtom)).toBe(snapshot);
    expect(fetchMock).not.toHaveBeenCalled();
    store.set(householdSnapshotAtom, {
      ...snapshot,
      scope_epoch: otherEpoch,
    });
    expect(store.get(filteredDevicesAtom)).toEqual([light, sensor, otherRoom]);
  });

  it("offers unassigned rooms and unknown categories without conflating them with all devices", () => {
    const unknown = device();
    const classified = device({
      id: "known",
      device_id: "known",
      room_id: "living",
      room_name: "客厅",
      category: "light",
    });
    store.set(householdSnapshotAtom, withDevices(unknown, classified));
    store.set(deviceFiltersAtom, {
      room: JSON.stringify(["home-1", null]),
      category: JSON.stringify(null),
      capability: "",
    });
    expect(store.get(filteredDevicesAtom)).toEqual([unknown]);
    const options = store.get(deviceFilterOptionsAtom);
    expect(options.rooms.map(([value]) => value)).toContain(
      JSON.stringify(["home-1", null]),
    );
    expect(options.categories.map(([value]) => value)).toContain(
      JSON.stringify(null),
    );
  });
});
