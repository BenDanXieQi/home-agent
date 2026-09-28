import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
  householdUpdatedAtom,
} from "../../../src/modules/household/state";
import { householdSyncStatusAtom } from "../../../src/modules/household/sync";
import {
  mijiaActionErrorAtom,
  mijiaCommandSyncPendingAtom,
  mijiaPendingCommandAtom,
  performMijiaAtom,
} from "../../../src/modules/mijia/commands";
import { canStartPlaybackAtom } from "../../../src/modules/playback/access";
import {
  commandResult,
  epoch,
  householdSnapshot,
  loginId,
  otherEpoch,
} from "../../support/household";
import { fetchMock, requestAt } from "../../support/http";

let store = createStore();

beforeEach(() => {
  store = createStore();
  vi.useFakeTimers();
  store.set(householdSnapshotAtom, householdSnapshot());
  store.set(householdSyncedAtom, true);
  store.set(householdUpdatedAtom, 100);
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("Mijia command coordination", () => {
  it.each([true, false])(
    "allows logout without SSE, with cached snapshot=%s",
    async (cached) => {
      store.set(householdSyncedAtom, false);
      if (!cached) store.set(householdSnapshotAtom, undefined);
      const baseline = store.get(householdSnapshotAtom);
      fetchMock.mockResolvedValueOnce(
        Response.json(commandResult(otherEpoch, 0)),
      );
      await store.set(performMijiaAtom, { type: "logout" });
      expect(requestAt(0).method).toBe("DELETE");
      expect(requestAt(0).url.pathname).toBe("/api/mijia/session");
      expect(store.get(householdSnapshotAtom)).toBe(baseline);
      expect(store.get(mijiaPendingCommandAtom)).toBeNull();
      expect(store.get(mijiaActionErrorAtom)).toBeNull();
      expect(store.get(mijiaCommandSyncPendingAtom)).toBe(true);
      expect(store.get(canStartPlaybackAtom)).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(store.get(mijiaActionErrorAtom)).toBeNull();
    },
  );

  it("cancels an explicitly identified login without any public snapshot", async () => {
    store.set(householdSyncedAtom, false);
    store.set(householdSnapshotAtom, undefined);
    fetchMock.mockResolvedValueOnce(Response.json(commandResult(epoch, 5)));
    await store.set(performMijiaAtom, {
      type: "cancelLogin",
      loginId,
    });
    expect(requestAt(0).url.pathname).toBe(`/api/mijia/login/${loginId}`);
    expect(requestAt(0).method).toBe("DELETE");
    expect(store.get(mijiaPendingCommandAtom)).toBeNull();
    expect(store.get(mijiaActionErrorAtom)).toBeNull();
    expect(store.get(householdSnapshotAtom)).toBeUndefined();
  });

  it.each([
    { type: "selectHome", homeId: "home-2" },
    { type: "refreshDevices" },
  ] as const)(
    "requires a known epoch for $type even when HTTP is available",
    async (command) => {
      store.set(householdSnapshotAtom, undefined);
      store.set(householdSyncedAtom, false);
      await store.set(performMijiaAtom, command);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.get(mijiaActionErrorAtom)).toBeTruthy();
      expect(store.get(mijiaPendingCommandAtom)).toBeNull();
    },
  );

  it("keeps the last known epoch on a disconnected scoped command for backend validation", async () => {
    store.set(householdSyncedAtom, false);
    fetchMock.mockResolvedValueOnce(Response.json(commandResult()));
    await store.set(performMijiaAtom, {
      type: "refreshDevices",
    });
    expect(requestAt(0).body).toEqual({
      scope_epoch: epoch,
      target: "directory",
    });
    expect(store.get(mijiaActionErrorAtom)).toBeNull();
  });

  it("serializes HTTP requests but releases commands while the accepted version awaits SSE", async () => {
    const baseline = store.get(householdSnapshotAtom);
    const response = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const pending = store.set(performMijiaAtom, {
      type: "selectHome",
      homeId: "home-2",
    });
    await flush();
    expect(store.get(householdSnapshotAtom)).toBe(baseline);
    expect(store.get(mijiaPendingCommandAtom)).toBe("selectHome");
    expect(requestAt(0).body).toEqual({
      scope_epoch: epoch,
      home_id: "home-2",
    });
    await store.set(performMijiaAtom, {
      type: "refreshDevices",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    response.resolve(Response.json(commandResult(otherEpoch, 4)));
    await pending;
    expect(store.get(mijiaPendingCommandAtom)).toBeNull();
    expect(store.get(mijiaCommandSyncPendingAtom)).toBe(true);
    expect(store.get(mijiaActionErrorAtom)).toBeNull();
    store.set(householdSnapshotAtom, {
      ...householdSnapshot(),
      sequence: 99,
    });
    expect(store.get(mijiaCommandSyncPendingAtom)).toBe(true);
    store.set(householdSnapshotAtom, {
      ...householdSnapshot(),
      scope_epoch: otherEpoch,
      sequence: 4,
    });
    expect(store.get(mijiaPendingCommandAtom)).toBeNull();
    expect(store.get(mijiaCommandSyncPendingAtom)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a stream confirmation that arrived before the HTTP response", async () => {
    const response = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const pending = store.set(performMijiaAtom, {
      type: "refreshDevices",
    });
    store.set(householdSnapshotAtom, {
      ...householdSnapshot(),
      sequence: 3,
    });
    response.resolve(Response.json(commandResult(epoch, 2)));
    await pending;
    expect(store.get(mijiaPendingCommandAtom)).toBeNull();
    expect(store.get(mijiaActionErrorAtom)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports pending synchronization without turning an accepted HTTP command into failure", async () => {
    const baseline = store.get(householdSnapshotAtom);
    fetchMock.mockResolvedValueOnce(Response.json(commandResult(epoch, 5)));
    const pending = store.set(performMijiaAtom, {
      type: "refreshDevices",
    });
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(store.get(householdSnapshotAtom)).toBe(baseline);
    expect(store.get(mijiaPendingCommandAtom)).toBeNull();
    expect(store.get(mijiaActionErrorAtom)).toBeNull();
    expect(store.get(mijiaCommandSyncPendingAtom)).toBe(true);
    expect(store.get(householdSyncStatusAtom)).toBe("confirming");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows cancellation to interrupt verification and ignores its late failure", async () => {
    const verification = Promise.withResolvers<Response>();
    const cancellation = Promise.withResolvers<Response>();
    fetchMock
      .mockReturnValueOnce(verification.promise)
      .mockReturnValueOnce(cancellation.promise);
    const verifying = store.set(performMijiaAtom, {
      type: "verifyLogin",
      loginId,
      ticket: "123456",
    });
    const cancelling = store.set(performMijiaAtom, {
      type: "cancelLogin",
      loginId,
    });
    expect(requestAt(0).signal?.aborted).toBe(true);
    verification.reject(new TypeError("late error"));
    await verifying;
    expect(store.get(mijiaPendingCommandAtom)).toBe("cancelLogin");
    expect(store.get(mijiaActionErrorAtom)).toBeNull();
    cancellation.resolve(Response.json(commandResult()));
    await cancelling;
    expect(store.get(mijiaPendingCommandAtom)).toBeNull();
    expect(store.get(mijiaActionErrorAtom)).toBeNull();
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
      await store.set(performMijiaAtom, {
        type: "refreshDevices",
      });
      expect(store.get(mijiaActionErrorAtom)).toBeTruthy();
      store.set(householdUpdatedAtom, 101);
      expect(store.get(mijiaActionErrorAtom) === null).toBe(expectedCleared);
    },
  );
});
