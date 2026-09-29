import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import {
  deviceInventoryAtom,
  devicesAtom,
} from "../../../src/modules/devices/state";
import { householdSnapshotAtom } from "../../../src/modules/household/state";
import { applyChanges, stateChangeSchema } from "@home-agent/api/household";
import {
  device,
  householdSnapshot,
  withDevices,
} from "../../support/household";

let store = createStore();

beforeEach(() => {
  store = createStore();
  store.set(householdSnapshotAtom, householdSnapshot());
});

describe("Device inventory projections", () => {
  it("keeps device array references and subscribers stable across unrelated public changes", () => {
    const snapshot = withDevices(device());
    store.set(householdSnapshotAtom, snapshot);
    const devices = store.get(devicesAtom);
    const changed = vi.fn();
    const unsubscribe = store.sub(devicesAtom, changed);
    try {
      for (const change of [
        {
          entity: "household",
          value: {
            ...snapshot.projection.household.household,
            cloud_synced_at: "2026-09-27T04:00:00.000Z",
          },
        },
        {
          entity: "account",
          value: {
            ...snapshot.projection.account.account,
            profile: { name: "更新后的名称", avatarUrl: null },
          },
        },
        {
          entity: "media",
          value: {
            ...snapshot.projection.media.media,
            revision: crypto.randomUUID(),
          },
        },
        {
          entity: "login",
          value: {
            ...snapshot.projection.login.login,
            material_version: 1,
          },
        },
      ]) {
        const previous = store.get(householdSnapshotAtom)!;
        const batch = stateChangeSchema.parse({
          scope_epoch: previous.scope_epoch,
          sequence: previous.sequence + 1,
          changes: [{ op: "upsert", key: change.entity, ...change }],
        });
        store.set(householdSnapshotAtom, {
          ...previous,
          sequence: batch.sequence,
          projection: applyChanges(previous.projection, batch),
        });
        expect(store.get(devicesAtom)).toBe(devices);
        expect(store.get(deviceInventoryAtom)?.items).toBe(devices);
      }
      expect(changed).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
