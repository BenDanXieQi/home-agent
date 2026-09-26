import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entityKey } from "@home-agent/api/household";
import { subscribeHousehold } from "../src/features/mijia/subscription";
import { appStore } from "../src/lib/store";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
  householdUpdatedAtom,
  householdReconnectAtom,
} from "../src/features/mijia/household-state";
import {
  device,
  epoch,
  householdSnapshot,
  otherEpoch,
} from "./support/household";
import {
  eventStream,
  fetchMock,
  requestAt,
  untilAborted,
} from "./support/http";

let stop = () => {};
let connections: ReturnType<typeof eventStream>[];
let visibility: EventTarget & { visibilityState: string };
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
  visibility = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", visibility);
  appStore.set(householdSnapshotAtom, undefined);
  appStore.set(householdSyncedAtom, false);
  appStore.set(householdUpdatedAtom, 0);
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
  const value = connections[index];
  if (!value) throw new Error(`Missing SSE connection ${index}`);
  return value;
}

async function start() {
  stop = subscribeHousehold();
  await flush();
  return connection();
}

describe("household stream ownership and version integrity", () => {
  it("decodes split UTF-8 and publishes an entire valid change batch once", async () => {
    const stream = await start();
    const snapshot = householdSnapshot();
    const text = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    const bytes = new TextEncoder().encode(text);
    const split = bytes.findIndex((byte) => byte > 127) + 1;
    stream.bytes(bytes.slice(0, split));
    await flush();
    expect(appStore.get(householdSnapshotAtom)).toBeUndefined();
    stream.bytes(bytes.slice(split));
    await flush();
    const changed = vi.fn();
    const unsubscribe = appStore.sub(householdSnapshotAtom, changed);
    try {
      const first = device();
      const second = device({ id: "device-2", device_id: "device-2" });
      stream.send("state_change", {
        scope_epoch: epoch,
        sequence: 2,
        changes: [first, second].map((value) => ({
          op: "upsert",
          entity: "device",
          key: entityKey(value.account_id, value.device_id),
          value,
        })),
      });
      await flush();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(
        Object.values(
          appStore.get(householdSnapshotAtom)?.projection.device ?? {},
        ),
      ).toEqual([first, second]);
      expect(appStore.get(householdSyncedAtom)).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("ignores repeated and older deltas without rolling back the displayed state", async () => {
    const stream = await start();
    stream.send("snapshot", householdSnapshot());
    stream.send("state_change", {
      scope_epoch: epoch,
      sequence: 2,
      changes: [],
    });
    await flush();
    const current = appStore.get(householdSnapshotAtom);
    for (const sequence of [2, 1])
      stream.send("state_change", {
        scope_epoch: epoch,
        sequence,
        changes: [],
      });
    await flush();
    expect(appStore.get(householdSnapshotAtom)).toBe(current);
    expect(stream.signal.aborted).toBe(false);
  });

  it("keeps a last valid snapshot on a version gap and reconnects for a complete baseline", async () => {
    const stream = await start();
    const snapshot = householdSnapshot();
    stream.send("snapshot", snapshot);
    stream.send("state_change", {
      scope_epoch: epoch,
      sequence: 3,
      changes: [],
    });
    await flush();
    expect(appStore.get(householdSnapshotAtom)).toEqual(snapshot);
    expect(appStore.get(householdSyncedAtom)).toBe(false);
    expect(stream.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(appStore.get(householdSyncedAtom)).toBe(false);
  });

  it.each(["state_change", "heartbeat"])(
    "rejects %s before this connection has its own snapshot",
    async (event) => {
      appStore.set(householdSnapshotAtom, householdSnapshot());
      const stream = await start();
      stream.send(event, { scope_epoch: epoch, sequence: 1, changes: [] });
      await flush();
      expect(stream.signal.aborted).toBe(true);
      expect(appStore.get(householdSnapshotAtom)).toBeUndefined();
      expect(appStore.get(householdSyncedAtom)).toBe(false);
    },
  );

  it.each(["state_change", "heartbeat"])(
    "clears stale ownership when %s belongs to a different scope",
    async (event) => {
      const stream = await start();
      stream.send("snapshot", householdSnapshot());
      stream.send(event, { scope_epoch: otherEpoch, sequence: 2, changes: [] });
      await flush();
      expect(appStore.get(householdSnapshotAtom)).toBeUndefined();
      expect(stream.signal.aborted).toBe(true);
    },
  );

  it("rejects an invalid member without exposing an earlier valid member of the same batch", async () => {
    const stream = await start();
    const snapshot = householdSnapshot();
    stream.send("snapshot", snapshot);
    await flush();
    const item = device();
    stream.send("state_change", {
      scope_epoch: epoch,
      sequence: 2,
      changes: [
        {
          op: "upsert",
          entity: "device",
          key: entityKey(item.account_id, item.device_id),
          value: item,
        },
        { op: "upsert", entity: "device", key: "wrong-identity", value: item },
      ],
    });
    await flush();
    expect(appStore.get(householdSnapshotAtom)).toEqual(snapshot);
    expect(appStore.get(householdSyncedAtom)).toBe(false);
  });

  it.each(["scope_changed", "stopping", "slow_client"])(
    "honors resync %s and its retry delay",
    async (reason) => {
      const stream = await start();
      stream.send("snapshot", householdSnapshot());
      stream.send("resync_required", {
        scope_epoch: epoch,
        sequence: 1,
        reason,
        retry_after_ms: 5_000,
      });
      await flush();
      expect(appStore.get(householdSnapshotAtom)).toEqual(
        reason === "slow_client" ? householdSnapshot() : undefined,
      );
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
});

describe("household stream transport lifecycle", () => {
  it("respects a 503 Retry-After without triggering directory reads", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 503, headers: { "Retry-After": "12" } }),
    );
    stop = subscribeHousehold();
    await flush();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.every(
        (_call, index) => requestAt(index).url.pathname === "/api/mijia/events",
      ),
    ).toBe(true);
  });

  it("does not let an aborted connection's finally invalidate its replacement", async () => {
    const first = await start();
    appStore.get(householdReconnectAtom)?.();
    await flush();
    const replacement = connection(1);
    replacement.send("snapshot", householdSnapshot());
    await flush();
    expect(first.signal.aborted).toBe(true);
    expect(appStore.get(householdSyncedAtom)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(appStore.get(householdSyncedAtom)).toBe(true);
  });

  it("allows valid heartbeats to keep sync but expires a silent connection after 45 seconds", async () => {
    const stream = await start();
    stream.send("snapshot", householdSnapshot());
    await vi.advanceTimersByTimeAsync(30_000);
    stream.send("heartbeat", { scope_epoch: epoch, sequence: 1 });
    await flush();
    await vi.advanceTimersByTimeAsync(44_999);
    expect(stream.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.signal.aborted).toBe(true);
    expect(appStore.get(householdSyncedAtom)).toBe(false);
  });

  it("times out a response that never supplies its first snapshot", async () => {
    const stream = await start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stream.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.signal.aborted).toBe(true);
    expect(appStore.get(householdSyncedAtom)).toBe(false);
  });

  it("aborts a request stalled before response headers at 10 seconds", async () => {
    fetchMock.mockImplementationOnce((_input, init) =>
      untilAborted(init?.signal),
    );
    stop = subscribeHousehold();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(requestAt(0).signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestAt(0).signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reconnects on visibility only when unsynced, then fully detaches on cleanup", async () => {
    const stream = await start();
    stream.send("snapshot", householdSnapshot());
    await flush();
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stream.end();
    await flush();
    visibility.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reconnect = appStore.get(householdReconnectAtom);
    stop();
    await flush();
    visibility.dispatchEvent(new Event("visibilitychange"));
    reconnect?.();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(connection(1).signal.aborted).toBe(true);
    expect(appStore.get(householdReconnectAtom)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
