import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
  householdUpdatedAtom,
} from "../../../src/modules/household/state";
import { startMijiaLoginAutomaticallyAtom } from "../../../src/modules/mijia/login";
import { commandResult, householdSnapshot } from "../../support/household";
import { fetchMock } from "../../support/http";

let store = createStore();

beforeEach(() => {
  store = createStore();
  vi.useFakeTimers();
  store.set(householdSnapshotAtom, householdSnapshot());
  store.set(householdSyncedAtom, true);
  store.set(householdUpdatedAtom, 100);
});

describe("Automatic login coordination", () => {
  it("deduplicates simultaneous automatic login callers and does not auto-loop after failure", async () => {
    const idle = householdSnapshot();
    idle.projection.account.account = { status: "idle" };
    idle.projection.media.media.binding = { status: "unbound" };
    store.set(householdSnapshotAtom, idle);
    const response = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const first = store.set(startMijiaLoginAutomaticallyAtom);
    const second = store.set(startMijiaLoginAutomaticallyAtom);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    response.reject(new TypeError("offline"));
    await Promise.all([first, second]);
    await store.set(startMijiaLoginAutomaticallyAtom);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a new login while cleanup has failed", async () => {
    const idle = householdSnapshot();
    idle.projection.account.account = { status: "idle" };
    idle.projection.media.media.binding = {
      status: "error",
      error: { code: "mijia_go2rtc_cleanup", message: "Cleanup failed" },
    };
    store.set(householdSnapshotAtom, idle);
    await store.set(startMijiaLoginAutomaticallyAtom);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for old media cleanup before automatically starting reauthentication", async () => {
    // docs/mijia.md requires completed media cleanup before automatic login.
    // A failed session DELETE retains its upstream unavailable code during cleanup.
    const expired = householdSnapshot();
    const error = {
      code: "mijia_authentication",
      message: "Account expired",
    } as const;
    expired.projection.account.account = { status: "reauth_required", error };
    expired.projection.media.media.binding = {
      status: "error",
      error: {
        code: "mijia_go2rtc_unavailable",
        message: "Old media cleanup failed",
      },
    };
    expired.projection.household.household = {
      provider: null,
      account_id: null,
      home_id: null,
      status: "unbound",
      stage: "account",
      homes: { selectedHomeId: null, status: "unselected" },
      sync_status: "error",
      cloud_synced_at: null,
      saved_at: null,
      error,
    };
    store.set(householdSnapshotAtom, expired);
    fetchMock.mockResolvedValueOnce(Response.json(commandResult()));
    await store.set(startMijiaLoginAutomaticallyAtom);
    expect(fetchMock.mock.calls.length).toBe(0);

    const cleaned = structuredClone(expired);
    cleaned.projection.media.media.binding = { status: "unbound" };
    store.set(householdSnapshotAtom, cleaned);
    await store.set(startMijiaLoginAutomaticallyAtom);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
