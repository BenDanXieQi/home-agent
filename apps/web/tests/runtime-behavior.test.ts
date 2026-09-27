import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entityKey } from "@home-agent/api/household";
import {
  accountId,
  commandResult,
  device,
  loadMijiaState,
  otherEpoch,
  withDevices,
} from "./support/household";
import { eventStream, fetchMock, requestAt } from "./support/http";

let state: Awaited<ReturnType<typeof loadMijiaState>>;
let subscribe: typeof import("../src/features/mijia/subscription").subscribeHousehold;
let stop = () => {};
let connections: ReturnType<typeof eventStream>[];
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(async () => {
  vi.resetModules();
  state = await loadMijiaState();
  subscribe = (await import("../src/features/mijia/subscription"))
    .subscribeHousehold;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  connections = [];
  fetchMock.mockImplementation(async (_input, init) => {
    const stream = eventStream(init?.signal);
    connections.push(stream);
    return stream.response;
  });
});

afterEach(async () => {
  stop();
  await flush();
});

function connection(index = 0) {
  const stream = connections[index];
  if (!stream) throw new Error(`Missing SSE connection ${index}`);
  return stream;
}

async function start() {
  stop = subscribe();
  await flush();
  return connection();
}

function householdIn(roomId: string, roomName: string, sequence = 1) {
  const snapshot = withDevices(
    device({
      room_id: roomId,
      room_name: roomName,
      camera: true,
      channels: [1],
    }),
    device({
      id: "device-2",
      device_id: "device-2",
      name: "卧室灯",
      room_id: "bedroom",
      room_name: "卧室",
    }),
  );
  snapshot.sequence = sequence;
  snapshot.projection.home = {
    [entityKey(accountId, "home-1")]: {
      account_id: accountId,
      home_id: "home-1",
      name: "家",
      shared: false,
      archived: false,
    },
  };
  snapshot.projection.room = Object.fromEntries(
    [
      { room_id: roomId, name: roomName },
      { room_id: "bedroom", name: "卧室" },
    ].map(({ room_id, name }) => [
      entityKey(accountId, "home-1", room_id),
      {
        account_id: accountId,
        home_id: "home-1",
        room_id,
        name,
        archived: false,
      },
    ]),
  );
  return snapshot;
}

function roomChange(
  previousRoom: string,
  next: ReturnType<typeof householdIn>,
) {
  const cameraKey = entityKey(accountId, "device-1");
  const camera = next.projection.device[cameraKey]!;
  const roomKey = entityKey(accountId, "home-1", camera.room_id!);
  return {
    scope_epoch: next.scope_epoch,
    sequence: next.sequence,
    changes: [
      {
        op: "remove",
        entity: "room",
        key: entityKey(accountId, "home-1", previousRoom),
      },
      {
        op: "upsert",
        entity: "room",
        key: roomKey,
        value: next.projection.room[roomKey],
      },
      {
        op: "upsert",
        entity: "device",
        key: cameraKey,
        value: camera,
      },
    ],
  };
}

function wireEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function expectConsistentRooms(snapshot: ReturnType<typeof householdIn>) {
  for (const item of Object.values(snapshot.projection.device)) {
    expect(item.home_id).toBe(snapshot.projection.household.household.home_id);
    expect(
      snapshot.projection.room[
        entityKey(item.account_id, item.home_id!, item.room_id!)
      ],
    ).toMatchObject({ room_id: item.room_id, name: item.room_name });
  }
}

describe("SC-16: subscription initialization and whole household updates", () => {
  // PUB-01, WEB-01: state observed between messages must still be a whole batch.
  it("receives a room move at the snapshot boundary and keeps later room names consistent", async () => {
    const stream = await start();
    const initial = householdIn("living", "客厅");
    const moved = householdIn("study", "书房", 2);
    const renamed = householdIn("study", "阅读室", 3);
    const observed: ReturnType<typeof householdIn>[] = [];
    const unsubscribe = state.appStore.sub(state.householdSnapshotAtom, () => {
      const snapshot = state.appStore.get(state.householdSnapshotAtom);
      if (snapshot) observed.push(snapshot);
    });
    try {
      const snapshotBytes = new TextEncoder().encode(
        wireEvent("snapshot", initial),
      );
      stream.bytes(snapshotBytes.slice(0, -2));
      await flush();
      expect(state.appStore.get(state.householdSnapshotAtom)).toBeUndefined();

      stream.bytes(
        new TextEncoder().encode(
          "\n\n" +
            wireEvent("state_change", roomChange("living", moved)) +
            wireEvent("state_change", roomChange("study", renamed)),
        ),
      );
      await flush();

      expect(state.appStore.get(state.householdSyncedAtom)).toBe(true);
      expect(state.appStore.get(state.householdSnapshotAtom)).toEqual(renamed);
      expect(observed.length).toBeGreaterThan(0);
      for (const snapshot of observed) expectConsistentRooms(snapshot);
      expect(state.appStore.get(state.devicesAtom)).toEqual(
        Object.values(renamed.projection.device),
      );
    } finally {
      unsubscribe();
    }
  });

  // WEB-02, WEB-03: rejection cannot expose half a move, and resync gets current data.
  it.each(["missing-version", "invalid-identity"] as const)(
    "recovers a complete current household after a room move and %s",
    async (failure) => {
      const stream = await start();
      const initial = householdIn("living", "客厅");
      const moved = householdIn("study", "书房", 2);
      stream.send("snapshot", initial);
      stream.send("state_change", roomChange("living", moved));
      await flush();

      const current = householdIn("kitchen", "厨房", 6);
      const rejected = roomChange("study", {
        ...current,
        sequence: failure === "missing-version" ? 4 : 3,
      });
      if (failure === "invalid-identity")
        rejected.changes.push({
          op: "upsert",
          entity: "device",
          key: "wrong-device-identity",
          value: device(),
        });
      const observed: ReturnType<typeof householdIn>[] = [];
      const unsubscribe = state.appStore.sub(
        state.householdSnapshotAtom,
        () => {
          const snapshot = state.appStore.get(state.householdSnapshotAtom);
          if (snapshot) observed.push(snapshot);
        },
      );
      try {
        stream.send("state_change", rejected);
        await flush();
        expect(state.appStore.get(state.householdSnapshotAtom)).toEqual(moved);
        expect(state.appStore.get(state.householdSyncedAtom)).toBe(false);
        expect(stream.signal.aborted).toBe(true);

        await vi.advanceTimersByTimeAsync(1_000);
        connection(1).send("snapshot", current);
        await flush();
        expect(state.appStore.get(state.householdSnapshotAtom)).toEqual(
          current,
        );
        expect(state.appStore.get(state.householdSyncedAtom)).toBe(true);
        for (const snapshot of observed) expectConsistentRooms(snapshot);
        expect(
          fetchMock.mock.calls.map(
            (_call, index) => requestAt(index).url.pathname,
          ),
        ).toEqual(["/api/mijia/events", "/api/mijia/events"]);
      } finally {
        unsubscribe();
      }
    },
  );
});

describe("SC-17: logout response and subscription confirmation", () => {
  // WEB-04, WEB-05: even a complete snapshot before HTTP ends is too early.
  it.each(["unbound", "initializing", "running"] as const)(
    "waits for a post-response snapshot and then checks its %s qualification",
    async (status) => {
      const stream = await start();
      const initial = householdIn("living", "客厅");
      stream.send("snapshot", initial);
      await flush();
      expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(true);

      const response = Promise.withResolvers<Response>();
      fetchMock.mockReturnValueOnce(response.promise);
      const logout = state.appStore.set(state.performMijiaAtom, {
        type: "logout",
      });
      expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(false);
      expect(requestAt(1)).toMatchObject({ method: "DELETE" });
      expect(requestAt(1).url.pathname).toBe("/api/mijia/session");

      state.appStore.set(state.refreshMijiaAtom);
      await vi.advanceTimersByTimeAsync(1_000);
      const beforeResponse = householdIn("living", "客厅", 2);
      connection(1).send("snapshot", beforeResponse);
      await flush();
      expect(state.appStore.get(state.householdSyncedAtom)).toBe(true);
      expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(false);

      response.resolve(Response.json(commandResult(otherEpoch, 1)));
      await logout;
      expect(state.appStore.get(state.householdSnapshotAtom)).toEqual(
        beforeResponse,
      );
      expect(state.appStore.get(state.mijiaPendingCommandAtom)).toBeNull();
      expect(state.appStore.get(state.mijiaCommandSyncPendingAtom)).toBe(true);
      expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(false);

      const confirmed = householdIn("study", "书房");
      // A later login may already have superseded the logout receipt's epoch.
      confirmed.scope_epoch =
        status === "unbound"
          ? otherEpoch
          : "a1000000-0000-4000-8000-000000000003";
      confirmed.projection.household.household.status = status;
      if (status !== "running") {
        confirmed.projection.household.household.stage =
          status === "unbound" ? "account" : "directory";
        confirmed.projection.household.household.sync_status = "unsynced";
        confirmed.projection.household.household.cloud_synced_at = null;
      }
      if (status === "unbound") {
        confirmed.projection.account.account = { status: "idle" };
        confirmed.projection.media.media.binding = { status: "unbound" };
      }
      const afterResponse = await vi.waitFor(() => connection(2), {
        timeout: 30_250,
      });
      afterResponse.send("snapshot", confirmed);
      await flush();

      expect(state.appStore.get(state.householdSyncedAtom)).toBe(true);
      expect(state.appStore.get(state.mijiaCommandSyncPendingAtom)).toBe(false);
      expect(state.appStore.get(state.householdSnapshotAtom)).toEqual(
        confirmed,
      );
      expect(state.appStore.get(state.mijiaCanStartPlaybackAtom)).toBe(
        status === "running",
      );
      expect(
        state.appStore.get(state.householdSnapshotAtom)?.projection.household
          .household.home_id,
      ).toBe("home-1");
      expect(
        fetchMock.mock.calls
          .map((_call, index) => requestAt(index).url.pathname)
          .filter((path) => path !== "/api/mijia/events"),
      ).toEqual(["/api/mijia/session"]);
    },
  );
});
