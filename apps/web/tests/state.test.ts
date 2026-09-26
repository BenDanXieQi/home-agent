import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyChanges, stateChangeSchema } from "@home-agent/api/household";
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

describe("HTTP command results and public stream confirmation are independent", () => {
  it.each([true, false])(
    "allows logout without SSE, with cached snapshot=%s",
    async (cached) => {
      state.appStore.set(state.householdSyncedAtom, false);
      if (!cached) state.appStore.set(state.householdSnapshotAtom, undefined);
      const baseline = state.appStore.get(state.householdSnapshotAtom);
      fetchMock.mockResolvedValueOnce(
        Response.json(commandResult(otherEpoch, 0)),
      );
      await state.appStore.set(state.performMijiaAtom, { type: "logout" });
      expect(requestAt(0).method).toBe("DELETE");
      expect(requestAt(0).url.pathname).toBe("/api/mijia/session");
      expect(state.appStore.get(state.householdSnapshotAtom)).toBe(baseline);
      expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBeNull();
      expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeNull();
      expect(state.appStore.get(state.mijiaCommandSyncPendingAtom)).toBe(true);
      expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeNull();
    },
  );

  it("cancels an explicitly identified login without any public snapshot", async () => {
    state.appStore.set(state.householdSyncedAtom, false);
    state.appStore.set(state.householdSnapshotAtom, undefined);
    fetchMock.mockResolvedValueOnce(Response.json(commandResult(epoch, 5)));
    await state.appStore.set(state.performMijiaAtom, {
      type: "cancelLogin",
      loginId,
    });
    expect(requestAt(0).url.pathname).toBe(`/api/mijia/login/${loginId}`);
    expect(requestAt(0).method).toBe("DELETE");
    expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBeNull();
    expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeNull();
    expect(state.appStore.get(state.householdSnapshotAtom)).toBeUndefined();
  });

  it.each([
    { type: "selectHome", homeId: "home-2" },
    { type: "refreshDevices" },
  ] as const)(
    "requires a known epoch for $type even when HTTP is available",
    async (command) => {
      state.appStore.set(state.householdSnapshotAtom, undefined);
      state.appStore.set(state.householdSyncedAtom, false);
      await state.appStore.set(state.performMijiaAtom, command);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeTruthy();
      expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBeNull();
    },
  );

  it("keeps the last known epoch on a disconnected scoped command for backend validation", async () => {
    state.appStore.set(state.householdSyncedAtom, false);
    fetchMock.mockResolvedValueOnce(Response.json(commandResult()));
    await state.appStore.set(state.performMijiaAtom, {
      type: "refreshDevices",
    });
    expect(requestAt(0).body).toEqual({
      scope_epoch: epoch,
      target: "directory",
    });
    expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeNull();
  });

  it("serializes HTTP requests but releases commands while the accepted version awaits SSE", async () => {
    const baseline = state.appStore.get(state.householdSnapshotAtom);
    const response = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
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
    response.resolve(Response.json(commandResult(otherEpoch, 4)));
    await pending;
    expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBeNull();
    expect(state.appStore.get(state.mijiaCommandSyncPendingAtom)).toBe(true);
    expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeNull();
    state.appStore.set(state.householdSnapshotAtom, {
      ...householdSnapshot(),
      sequence: 99,
    });
    expect(state.appStore.get(state.mijiaCommandSyncPendingAtom)).toBe(true);
    state.appStore.set(state.householdSnapshotAtom, {
      ...householdSnapshot(),
      scope_epoch: otherEpoch,
      sequence: 4,
    });
    expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBeNull();
    expect(state.appStore.get(state.mijiaCommandSyncPendingAtom)).toBe(false);
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

  it("reports pending synchronization without turning an accepted HTTP command into failure", async () => {
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
    expect(state.appStore.get(state.mijiaActionErrorAtom)).toBeNull();
    expect(state.appStore.get(state.mijiaCommandSyncPendingAtom)).toBe(true);
    expect(state.appStore.get(state.mijiaFetchErrorAtom)).toContain(
      "操作已接收",
    );
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
  it("keeps device array references and subscribers stable across unrelated public changes", () => {
    const snapshot = withDevices(device());
    state.appStore.set(state.householdSnapshotAtom, snapshot);
    const devices = state.appStore.get(state.devicesAtom);
    const changed = vi.fn();
    const unsubscribe = state.appStore.sub(state.devicesAtom, changed);
    try {
      for (const change of [
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
        const previous = state.appStore.get(state.householdSnapshotAtom)!;
        const batch = stateChangeSchema.parse({
          scope_epoch: previous.scope_epoch,
          sequence: previous.sequence + 1,
          changes: [{ op: "upsert", key: change.entity, ...change }],
        });
        state.appStore.set(state.householdSnapshotAtom, {
          ...previous,
          sequence: batch.sequence,
          projection: applyChanges(previous.projection, batch),
        });
        expect(state.appStore.get(state.devicesAtom)).toBe(devices);
        expect(state.appStore.get(state.mijiaStateAtom)?.devices.items).toBe(
          devices,
        );
      }
      expect(changed).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

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

  it("keeps playback across short stream loss but requires a fresh snapshot after uncertain logout", async () => {
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(true);
    state.appStore.set(state.householdSyncedAtom, false);
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(true);
    expect(state.appStore.get(state.mijiaReliableAtom)).toBe(false);
    state.appStore.set(state.householdSyncedAtom, true);
    const reconnect = vi.fn();
    state.appStore.set(state.householdReconnectAtom, () => reconnect);
    fetchMock.mockRejectedValueOnce(new TypeError("response lost"));
    await state.appStore.set(state.performMijiaAtom, {
      type: "logout",
    });
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(false);
    state.appStore.set(state.householdUpdatedAtom, 101);
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(false);
    expect(reconnect).toHaveBeenCalledTimes(1);
    state.appStore.set(state.householdSnapshotAtom, householdSnapshot());
    state.appStore.set(state.householdSnapshotReceivedAtom, 1);
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(true);
  });

  it("does not let old heartbeats or cached snapshots satisfy a logout receipt", async () => {
    const reconnect = vi.fn();
    state.appStore.set(state.householdReconnectAtom, () => reconnect);
    fetchMock.mockResolvedValueOnce(
      Response.json(commandResult(otherEpoch, 4)),
    );
    await state.appStore.set(state.performMijiaAtom, { type: "logout" });
    state.appStore.set(state.householdUpdatedAtom, 101);
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(false);
    state.appStore.set(state.householdSnapshotAtom, {
      ...householdSnapshot(),
      sequence: 100,
    });
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(false);
    expect(state.appStore.get(state.mijiaCommandSyncPendingAtom)).toBe(true);
    expect(reconnect).toHaveBeenCalledTimes(1);
    const latest = householdSnapshot();
    latest.scope_epoch = crypto.randomUUID();
    state.appStore.set(state.householdSnapshotAtom, latest);
    state.appStore.set(state.householdSnapshotReceivedAtom, 1);
    expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(true);
    expect(state.appStore.get(state.mijiaCommandSyncPendingAtom)).toBe(false);
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
    state.appStore.set(state.householdSnapshotAtom, snapshot);
    state.appStore.set(state.deviceFiltersAtom, {
      room: JSON.stringify(["home-1", "living"]),
      category: JSON.stringify("light"),
      capability: "writeable",
    });
    expect(state.appStore.get(state.filteredDevicesAtom)).toEqual([light]);
    expect(state.appStore.get(state.householdSnapshotAtom)).toBe(snapshot);
    expect(fetchMock).not.toHaveBeenCalled();
    state.appStore.set(state.householdSnapshotAtom, {
      ...snapshot,
      scope_epoch: otherEpoch,
    });
    expect(state.appStore.get(state.filteredDevicesAtom)).toEqual([
      light,
      sensor,
      otherRoom,
    ]);
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
    state.appStore.set(
      state.householdSnapshotAtom,
      withDevices(unknown, classified),
    );
    state.appStore.set(state.deviceFiltersAtom, {
      room: JSON.stringify(["home-1", null]),
      category: JSON.stringify(null),
      capability: "",
    });
    expect(state.appStore.get(state.filteredDevicesAtom)).toEqual([unknown]);
    const options = state.appStore.get(state.deviceFilterOptionsAtom);
    expect(options.rooms).toContainEqual([
      JSON.stringify(["home-1", null]),
      "未分配房间",
    ]);
    expect(options.categories).toContainEqual([JSON.stringify(null), "未分类"]);
  });
});
