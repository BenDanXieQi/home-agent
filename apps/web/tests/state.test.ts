import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commandResult,
  device,
  epoch,
  householdSnapshot,
  loadMijiaState,
  loginId,
  otherEpoch,
  withDevices,
} from "./support/household";
import { fetchMock, requestAt } from "./support/http";

let state: Awaited<ReturnType<typeof loadMijiaState>>;

beforeEach(async () => {
  vi.resetModules();
  state = await loadMijiaState();
  vi.useFakeTimers();
  state.appStore.set(state.householdSnapshotAtom, householdSnapshot());
  state.appStore.set(state.householdSyncedAtom, true);
  state.appStore.set(state.householdUpdatedAtom, 100);
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("commands wait for the authoritative public stream", () => {
  it("does not submit commands from a cached but unsynced snapshot", async () => {
    state.appStore.set(state.householdSyncedAtom, false);
    await state.appStore.set(state.performMijiaAtom, { type: "logout" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.appStore.get(state.mijiaAccountLabelAtom)).toBe("状态不可用");
  });

  it("serializes commands and waits for the accepted epoch and sequence without writing HTTP state", async () => {
    const baseline = state.appStore.get(state.householdSnapshotAtom);
    fetchMock.mockResolvedValueOnce(
      Response.json(commandResult(otherEpoch, 4)),
    );
    const pending = state.appStore.set(state.performMijiaAtom, {
      type: "selectHome",
      homeId: "home-2",
    });
    await flush();
    expect(state.appStore.get(state.householdSnapshotAtom)).toBe(baseline);
    expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBe(
      "selectHome",
    );
    expect(requestAt(0).body).toEqual({
      scope_epoch: epoch,
      home_id: "home-2",
    });
    await state.appStore.set(state.performMijiaAtom, {
      type: "refreshDevices",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    state.appStore.set(state.householdSnapshotAtom, {
      ...householdSnapshot(),
      sequence: 99,
    });
    await flush();
    expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBe(
      "selectHome",
    );
    state.appStore.set(state.householdSnapshotAtom, {
      ...householdSnapshot(),
      scope_epoch: otherEpoch,
      sequence: 4,
    });
    await pending;
    expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a stream confirmation that arrived before the HTTP response", async () => {
    const response = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const pending = state.appStore.set(state.performMijiaAtom, {
      type: "refreshDevices",
    });
    state.appStore.set(state.householdSnapshotAtom, {
      ...householdSnapshot(),
      sequence: 3,
    });
    response.resolve(Response.json(commandResult(epoch, 2)));
    await pending;
    expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBeNull();
    expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the pending command after a missing confirmation instead of inventing a snapshot", async () => {
    const baseline = state.appStore.get(state.householdSnapshotAtom);
    fetchMock.mockResolvedValueOnce(Response.json(commandResult(epoch, 5)));
    const pending = state.appStore.set(state.performMijiaAtom, {
      type: "refreshDevices",
    });
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(state.appStore.get(state.householdSnapshotAtom)).toBe(baseline);
    expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBeNull();
    expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows cancellation to interrupt verification and ignores its late failure", async () => {
    const verification = Promise.withResolvers<Response>();
    const cancellation = Promise.withResolvers<Response>();
    fetchMock
      .mockReturnValueOnce(verification.promise)
      .mockReturnValueOnce(cancellation.promise);
    const verifying = state.appStore.set(state.performMijiaAtom, {
      type: "verifyLogin",
      loginId,
      ticket: "123456",
    });
    const cancelling = state.appStore.set(state.performMijiaAtom, {
      type: "cancelLogin",
      loginId,
    });
    expect(requestAt(0).signal?.aborted).toBe(true);
    verification.reject(new TypeError("late error"));
    await verifying;
    expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBe(
      "cancelLogin",
    );
    expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeNull();
    cancellation.resolve(Response.json(commandResult()));
    await cancelling;
    expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBeNull();
    expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeNull();
  });

  it.each([
    { transport: true, expectedCleared: true },
    { transport: false, expectedCleared: false },
  ])(
    "a fresh stream message clears transport=$transport errors according to ownership",
    async ({ transport, expectedCleared }) => {
      if (transport) fetchMock.mockRejectedValueOnce(new TypeError("offline"));
      else
        fetchMock.mockResolvedValueOnce(
          Response.json(
            { code: "mijia_home_unavailable", message: "Home revoked" },
            { status: 409 },
          ),
        );
      await state.appStore.set(state.performMijiaAtom, {
        type: "refreshDevices",
      });
      expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeTruthy();
      state.appStore.set(state.householdUpdatedAtom, 101);
      expect(state.appStore.get(state.mijiaActionErrorAtom) === null).toBe(
        expectedCleared,
      );
    },
  );
});

describe("shared account and playback gates", () => {
  it("deduplicates simultaneous automatic login callers and does not auto-loop after failure", async () => {
    const idle = householdSnapshot();
    idle.projection.account.account = { status: "idle" };
    idle.projection.media.media.binding = { status: "unbound" };
    state.appStore.set(state.householdSnapshotAtom, idle);
    const response = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const first = state.appStore.set(state.startMijiaLoginAutomaticallyAtom);
    const second = state.appStore.set(state.startMijiaLoginAutomaticallyAtom);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    response.reject(new TypeError("offline"));
    await Promise.all([first, second]);
    await state.appStore.set(state.startMijiaLoginAutomaticallyAtom);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a new login while cleanup has failed", async () => {
    const idle = householdSnapshot();
    idle.projection.account.account = { status: "idle" };
    idle.projection.media.media.binding = {
      status: "error",
      error: { code: "mijia_go2rtc_cleanup", message: "Cleanup failed" },
    };
    state.appStore.set(state.householdSnapshotAtom, idle);
    await state.appStore.set(state.startMijiaLoginAutomaticallyAtom);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for old media cleanup before automatically starting reauthentication", async () => {
    // device-access-code-reference.md §10.4 requires no pending media cleanup.
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
      account_id: null,
      home_id: null,
      status: "unbound",
      stage: "account",
      homes: { selectedHomeId: null, status: "unselected", items: [] },
      sync_status: "error",
      cloud_synced_at: null,
      saved_at: null,
      error,
    };
    state.appStore.set(state.householdSnapshotAtom, expired);
    fetchMock.mockResolvedValueOnce(Response.json(commandResult()));
    await state.appStore.set(state.startMijiaLoginAutomaticallyAtom);
    expect(fetchMock.mock.calls.length).toBe(0);

    const cleaned = structuredClone(expired);
    cleaned.projection.media.media.binding = { status: "unbound" };
    state.appStore.set(state.householdSnapshotAtom, cleaned);
    await state.appStore.set(state.startMijiaLoginAutomaticallyAtom);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps playback eligibility across short stream loss but requires a new message after uncertain home switching", async () => {
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(true);
    state.appStore.set(state.householdSyncedAtom, false);
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(true);
    expect(state.appStore.get(state.mijiaReliableAtom)).toBe(false);
    state.appStore.set(state.householdSyncedAtom, true);
    fetchMock.mockRejectedValueOnce(new TypeError("response lost"));
    await state.appStore.set(state.performMijiaAtom, {
      type: "selectHome",
      homeId: "home-2",
    });
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(false);
    state.appStore.set(state.householdUpdatedAtom, 101);
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(true);
  });

  it("restored cached devices do not grant playback before the household runs", () => {
    const cached = withDevices(device());
    cached.projection.household.household.status = "initializing";
    cached.projection.household.household.sync_status = "unsynced";
    state.appStore.set(state.householdSnapshotAtom, cached);
    expect(state.appStore.get(state.devicesAtom)).toHaveLength(1);
    expect(state.appStore.get(state.mijiaDeviceCountAtom)).toBeNull();
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(false);
  });

  it("refresh reconnects the state stream without issuing a directory cloud command", () => {
    const reconnect = vi.fn();
    state.appStore.set(state.householdReconnectAtom, () => reconnect);
    state.appStore.set(state.refreshMijiaAtom);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters by runtime availability rather than cloud online, and searches normalized aliases", () => {
    const unknown = device({ online: true, availability: "unknown" });
    const online = device({
      id: "device-2",
      device_id: "device-2",
      online: false,
      availability: "online",
      alias: "Reading Light",
    });
    state.appStore.set(
      state.householdSnapshotAtom,
      withDevices(unknown, online),
    );
    state.appStore.set(state.deviceFilterAtom, "online");
    expect(state.appStore.get(state.filteredDevicesAtom)).toEqual([online]);
    state.appStore.set(state.deviceFilterAtom, "unknown");
    expect(state.appStore.get(state.filteredDevicesAtom)).toEqual([unknown]);
    state.appStore.set(state.deviceFilterAtom, "all");
    state.appStore.set(state.deviceSearchAtom, "  READING  ");
    expect(state.appStore.get(state.filteredDevicesAtom)).toEqual([online]);
  });
});
