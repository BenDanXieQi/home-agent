import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import {
  deviceCountAtom,
  devicesAtom,
} from "../../../src/modules/devices/state";
import {
  householdReconnectAtom,
  householdSnapshotAtom,
  householdSnapshotReceivedAtom,
  householdSyncedAtom,
  householdUpdatedAtom,
} from "../../../src/modules/household/state";
import { householdReliableAtom } from "../../../src/modules/household/sync";
import {
  mijiaCommandSyncPendingAtom,
  performMijiaAtom,
} from "../../../src/modules/mijia/commands";
import { canStartPlaybackAtom } from "../../../src/modules/playback/access";
import {
  commandResult,
  device,
  householdSnapshot,
  otherEpoch,
  withDevices,
} from "../../support/household";
import { fetchMock } from "../../support/http";

let store = createStore();

beforeEach(() => {
  store = createStore();
  vi.useFakeTimers();
  store.set(householdSnapshotAtom, householdSnapshot());
  store.set(householdSyncedAtom, true);
  store.set(householdUpdatedAtom, 100);
});

describe("Playback access confirmation", () => {
  it("keeps playback across short stream loss but requires a fresh snapshot after uncertain logout", async () => {
    expect(store.get(canStartPlaybackAtom)).toBe(true);
    store.set(householdSyncedAtom, false);
    expect(store.get(canStartPlaybackAtom)).toBe(true);
    expect(store.get(householdReliableAtom)).toBe(false);
    store.set(householdSyncedAtom, true);
    const reconnect = vi.fn();
    store.set(householdReconnectAtom, () => reconnect);
    fetchMock.mockRejectedValueOnce(new TypeError("response lost"));
    await store.set(performMijiaAtom, {
      type: "logout",
    });
    expect(store.get(canStartPlaybackAtom)).toBe(false);
    store.set(householdUpdatedAtom, 101);
    expect(store.get(canStartPlaybackAtom)).toBe(false);
    expect(reconnect).toHaveBeenCalledTimes(1);
    store.set(householdSnapshotAtom, householdSnapshot());
    store.set(householdSnapshotReceivedAtom, 1);
    expect(store.get(canStartPlaybackAtom)).toBe(true);
  });

  it("does not let old heartbeats or cached snapshots satisfy a logout receipt", async () => {
    const reconnect = vi.fn();
    store.set(householdReconnectAtom, () => reconnect);
    fetchMock.mockResolvedValueOnce(
      Response.json(commandResult(otherEpoch, 4)),
    );
    await store.set(performMijiaAtom, { type: "logout" });
    store.set(householdUpdatedAtom, 101);
    expect(store.get(canStartPlaybackAtom)).toBe(false);
    store.set(householdSnapshotAtom, {
      ...householdSnapshot(),
      sequence: 100,
    });
    expect(store.get(canStartPlaybackAtom)).toBe(false);
    expect(store.get(mijiaCommandSyncPendingAtom)).toBe(true);
    expect(reconnect).toHaveBeenCalledTimes(1);
    const latest = householdSnapshot();
    latest.scope_epoch = crypto.randomUUID();
    store.set(householdSnapshotAtom, latest);
    store.set(householdSnapshotReceivedAtom, 1);
    expect(store.get(canStartPlaybackAtom)).toBe(true);
    expect(store.get(mijiaCommandSyncPendingAtom)).toBe(false);
  });

  it("restored cached devices do not grant playback before the household runs", () => {
    const cached = withDevices(device());
    cached.projection.household.household.status = "initializing";
    cached.projection.household.household.sync_status = "unsynced";
    store.set(householdSnapshotAtom, cached);
    expect(store.get(devicesAtom)).toHaveLength(1);
    expect(store.get(deviceCountAtom)).toBeNull();
    expect(store.get(canStartPlaybackAtom)).toBe(false);
  });
});
