import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import {
  deviceLogEntrySchema,
  deviceLogRunSchema,
} from "@home-agent/api/device-logs";
import { householdSnapshotAtom } from "../../../src/modules/household/state";
import {
  captureLogsAtom,
  deviceLogCaptureAtom,
  deviceLogReconnectAtom,
  deviceLogScopeAtom,
  deviceLogStateAtom,
  receiveDeviceLogsAtom,
} from "../../../src/modules/device-logs/state";
import { accountId, epoch, householdSnapshot } from "../../support/household";
import { fetchMock } from "../../support/http";

let store = createStore();
const runId = "a6000000-0000-4000-8000-000000000001";
const nextRunId = "a6000000-0000-4000-8000-000000000002";

function run(id = runId) {
  return deviceLogRunSchema.parse({
    id,
    account_id: accountId,
    home_id: "home-1",
    home_name: "家",
    scope_epoch: epoch,
    status: "capturing",
    reason: null,
    started_at: "2026-09-01T00:00:00.000Z",
    finished_at: null,
    duration_seconds: 600,
    elapsed_seconds: 0,
    device_count: 1,
    excluded_devices: [],
    expected_topics: 1,
    confirmed_topics: 1,
    failed_topics: 0,
    all_confirmed_at: null,
    connection: "connected",
    disconnections: 0,
    packets: 0,
    payload_bytes: 0,
    property_reports: 0,
    online_reports: 0,
    first_reports: 0,
    value_changes: 0,
    same_value_reports: 0,
    retained_reports: 0,
    total_rows: 0,
    minutes: [],
    devices: [],
  });
}

function entry(sequence: number) {
  return deviceLogEntrySchema.parse({
    sequence,
    received_at: "2026-09-01T00:00:00.000Z",
    kind: "property",
    device_id: "device-1",
    device_name: "灯",
    room_name: "客厅",
    property: "power",
    description: "开关",
    value: "true",
    previous_value: null,
    change: "first",
    observation: {},
  });
}

beforeEach(() => {
  store = createStore();
  store.set(householdSnapshotAtom, householdSnapshot());
});

describe("Device log state ownership", () => {
  it("ignores a previous household's stream and mismatched run without replacing current data", () => {
    const scope = store.get(deviceLogScopeAtom);
    store.set(
      receiveDeviceLogsAtom,
      scope,
      { run: run(), entries: [entry(1)] },
      true,
    );
    const baseline = store.get(deviceLogStateAtom);
    store.set(
      receiveDeviceLogsAtom,
      "old-scope",
      { run: run(), entries: [entry(2)] },
      false,
    );
    store.set(
      receiveDeviceLogsAtom,
      scope,
      { run: { ...run(), home_id: "other-home" }, entries: [] },
      true,
    );
    expect(store.get(deviceLogStateAtom)).toBe(baseline);
  });

  it("bounds accumulated entries and replaces them on a new run or full snapshot", () => {
    const scope = store.get(deviceLogScopeAtom);
    const initial = Array.from({ length: 499 }, (_, index) => entry(index + 1));
    store.set(
      receiveDeviceLogsAtom,
      scope,
      { run: run(), entries: initial },
      true,
    );
    store.set(
      receiveDeviceLogsAtom,
      scope,
      { run: run(), entries: [entry(500), entry(501)] },
      false,
    );
    expect(
      store
        .get(deviceLogStateAtom)
        .data.entries.map(({ sequence }) => sequence),
    ).toEqual(Array.from({ length: 500 }, (_, index) => index + 2));
    store.set(
      receiveDeviceLogsAtom,
      scope,
      { run: run(nextRunId), entries: [entry(1)] },
      false,
    );
    expect(store.get(deviceLogStateAtom).data.entries).toEqual([entry(1)]);
    store.set(
      receiveDeviceLogsAtom,
      scope,
      { run: run(nextRunId), entries: [entry(8)] },
      true,
    );
    expect(store.get(deviceLogStateAtom).data.entries).toEqual([entry(8)]);
  });
});

describe("Capture command confirmation", () => {
  it("deduplicates requests until stream confirmation and does not revive a completed command", async () => {
    const scope = store.get(deviceLogScopeAtom);
    store.set(receiveDeviceLogsAtom, scope, { run: null, entries: [] }, true);
    const reconnect = vi.fn();
    store.set(deviceLogReconnectAtom, () => reconnect);
    const response = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const pending = store.set(captureLogsAtom, { action: "start", scope });
    expect(store.get(deviceLogCaptureAtom).phase).toBe("sending");
    expect(await store.set(captureLogsAtom, { action: "start", scope })).toBe(
      false,
    );
    response.resolve(Response.json({ run: run(), entries: [] }));
    expect(await pending).toBe(true);
    expect(store.get(deviceLogCaptureAtom).phase).toBe("confirming");
    expect(await store.set(captureLogsAtom, { action: "start", scope })).toBe(
      false,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    store.set(receiveDeviceLogsAtom, scope, { run: run(), entries: [] }, false);
    expect(store.get(deviceLogCaptureAtom).phase).toBe("success");
    store.set(deviceLogStateAtom, {
      ...store.get(deviceLogStateAtom),
      connected: false,
    });
    store.set(receiveDeviceLogsAtom, scope, { run: null, entries: [] }, true);
    expect(store.get(deviceLogCaptureAtom).phase).toBe("success");
  });

  it.each(["start", "stop"] as const)(
    "requires evidence of an uncertain %s before clearing the error",
    async (action) => {
      const scope = store.get(deviceLogScopeAtom);
      const baseline = run();
      store.set(
        receiveDeviceLogsAtom,
        scope,
        { run: baseline, entries: [] },
        true,
      );
      fetchMock.mockRejectedValueOnce(new TypeError("response lost"));
      expect(await store.set(captureLogsAtom, { action, scope })).toBe(false);
      expect(store.get(deviceLogCaptureAtom).phase).toBe("error");
      store.set(
        receiveDeviceLogsAtom,
        scope,
        { run: baseline, entries: [] },
        true,
      );
      expect(store.get(deviceLogCaptureAtom).phase).toBe("error");
      const observed =
        action === "start"
          ? run(nextRunId)
          : { ...baseline, status: "stopped" as const };
      store.set(
        receiveDeviceLogsAtom,
        scope,
        { run: observed, entries: [] },
        false,
      );
      expect(store.get(deviceLogCaptureAtom)).toMatchObject({
        phase: "success",
        error: null,
      });
    },
  );

  it("does not apply a late command result or reconnect request to a different household", async () => {
    const oldScope = store.get(deviceLogScopeAtom);
    store.set(
      receiveDeviceLogsAtom,
      oldScope,
      { run: null, entries: [] },
      true,
    );
    const response = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const pending = store.set(captureLogsAtom, {
      action: "start",
      scope: oldScope,
    });
    const next = householdSnapshot();
    next.projection.household.household.home_id = "home-2";
    store.set(householdSnapshotAtom, next);
    const scope = store.get(deviceLogScopeAtom);
    store.set(receiveDeviceLogsAtom, scope, { run: null, entries: [] }, true);
    const reconnect = vi.fn();
    store.set(deviceLogReconnectAtom, () => reconnect);
    response.resolve(Response.json({ run: run(), entries: [] }));
    await pending;
    store.set(
      receiveDeviceLogsAtom,
      oldScope,
      { run: run(), entries: [entry(1)] },
      true,
    );
    expect(store.get(deviceLogCaptureAtom)).toMatchObject({
      phase: "idle",
      action: null,
      error: null,
    });
    expect(store.get(deviceLogStateAtom)).toMatchObject({
      scope,
      data: { run: null, entries: [] },
    });
    expect(reconnect).not.toHaveBeenCalled();
  });
});
