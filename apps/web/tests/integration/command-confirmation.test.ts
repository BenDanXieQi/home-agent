import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import {
  commandResult,
  householdSnapshot,
  otherEpoch,
} from "../support/household";
import { eventStream, fetchMock, requestAt } from "../support/http";
import { subscribeHousehold } from "../../src/modules/household/subscription";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
  reconnectHouseholdAtom,
} from "../../src/modules/household/state";
import {
  mijiaCommandSyncPendingAtom,
  mijiaPendingCommandAtom,
  performMijiaAtom,
} from "../../src/modules/mijia/commands";
import { canStartPlaybackAtom } from "../../src/modules/playback/access";

let store = createStore();
let stop = () => {};
let connections: ReturnType<typeof eventStream>[];
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  store = createStore();
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
  stop = subscribeHousehold(store);
  await flush();
  return connection();
}

describe("Logout confirmation across HTTP and the household stream", () => {
  it.each(["unbound", "initializing", "running"] as const)(
    "waits for a post-response snapshot and then checks its %s qualification",
    async (status) => {
      const stream = await start();
      const initial = householdSnapshot();
      stream.send("snapshot", initial);
      await flush();
      expect(store.get(canStartPlaybackAtom)).toBe(true);

      const response = Promise.withResolvers<Response>();
      fetchMock.mockReturnValueOnce(response.promise);
      const logout = store.set(performMijiaAtom, {
        type: "logout",
      });
      expect(store.get(canStartPlaybackAtom)).toBe(false);
      expect(requestAt(1)).toMatchObject({ method: "DELETE" });
      expect(requestAt(1).url.pathname).toBe("/api/mijia/session");

      store.set(reconnectHouseholdAtom);
      await vi.advanceTimersByTimeAsync(1_000);
      const beforeResponse = { ...householdSnapshot(), sequence: 2 };
      connection(1).send("snapshot", beforeResponse);
      await flush();
      expect(store.get(householdSyncedAtom)).toBe(true);
      expect(store.get(canStartPlaybackAtom)).toBe(false);

      response.resolve(Response.json(commandResult(otherEpoch, 1)));
      await logout;
      expect(store.get(householdSnapshotAtom)).toEqual(beforeResponse);
      expect(store.get(mijiaPendingCommandAtom)).toBeNull();
      expect(store.get(mijiaCommandSyncPendingAtom)).toBe(true);
      expect(store.get(canStartPlaybackAtom)).toBe(false);

      const confirmed = householdSnapshot();
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

      expect(store.get(householdSyncedAtom)).toBe(true);
      expect(store.get(mijiaCommandSyncPendingAtom)).toBe(false);
      expect(store.get(householdSnapshotAtom)).toEqual(confirmed);
      expect(store.get(canStartPlaybackAtom)).toBe(status === "running");
      expect(
        store.get(householdSnapshotAtom)?.projection.household.household
          .home_id,
      ).toBe("home-1");
      expect(
        fetchMock.mock.calls
          .map((_call, index) => requestAt(index).url.pathname)
          .filter((path) => path !== "/api/mijia/events"),
      ).toEqual(["/api/mijia/session"]);
    },
  );
});
