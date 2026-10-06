import { addAbortListener } from "node:events";
import {
  deviceHistoryChangeSchema,
  deviceHistoryRecordId,
  deviceHistoryStreamPolicy,
  type deviceHistoryResponseSchema,
  type deviceHistoryStreamEventSchema,
  type deviceHistoryStreamRequestSchema,
} from "@home-agent/api/device-history";
import { jsonBytes } from "../config";
import { HouseholdError } from "../errors";
import { normalizeDeviceHistoryQuery } from "./query";
import {
  historyPageExpiresAt,
  type createDeviceHistoryLiveReader,
} from "./live";
import type { createDeviceHistoryReader } from "./read";
import type { createDeviceHistoryService } from "./service";

function pageChanges(
  previous: ReturnType<typeof deviceHistoryResponseSchema.parse>,
  next: ReturnType<typeof deviceHistoryResponseSchema.parse>,
) {
  const previousRecords = new Map(
    previous.records.map((record) => [
      deviceHistoryRecordId(record),
      JSON.stringify(record),
    ]),
  );
  const recordIds = next.records.map(deviceHistoryRecordId);
  const retained = new Set(recordIds);
  return deviceHistoryChangeSchema.parse({
    ...next,
    records: next.records.filter(
      (record) =>
        previousRecords.get(deviceHistoryRecordId(record)) !==
        JSON.stringify(record),
    ),
    record_ids: recordIds,
    removed_ids: [...previousRecords.keys()].filter((id) => !retained.has(id)),
  });
}

/** Deliver database pages; commit notifications only invalidate the live first page. */
export async function deliverDeviceHistory({
  input,
  read,
  history,
  signal,
  assertCurrent,
  send,
  liveRead,
  scope,
}: {
  input: ReturnType<typeof deviceHistoryStreamRequestSchema.parse>;
  read: ReturnType<typeof createDeviceHistoryReader>;
  history:
    | Pick<ReturnType<typeof createDeviceHistoryService>, "subscribe">
    | undefined;
  liveRead: ReturnType<typeof createDeviceHistoryLiveReader>;
  scope: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  send: (
    event: ReturnType<typeof deviceHistoryStreamEventSchema.parse>,
  ) => Promise<void>;
}) {
  const { delivery, ...query } = input;
  if (delivery !== "live") {
    assertCurrent();
    if (delivery === "export") {
      await read.export(query, signal, async (page) => {
        assertCurrent();
        await send({ event: "page", data: page });
      });
    } else {
      const page = await read(query, signal, jsonBytes);
      assertCurrent();
      await send({ event: "page", data: page });
    }
    assertCurrent();
    await send({ event: "complete", data: {} });
    return;
  }
  if (!history) throw new HouseholdError("home_storage");
  const start = Date.parse(query.start);
  let wake = Promise.withResolvers<void>();
  let dirty = false;
  let coalescing: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const scheduleExpiry = (
    page: ReturnType<typeof deviceHistoryResponseSchema.parse>,
  ) => {
    clearTimeout(expiry);
    const expiresAt = historyPageExpiresAt(page);
    if (!Number.isFinite(expiresAt)) return;
    expiry = setTimeout(
      () => {
        dirty = true;
        wake.resolve();
      },
      Math.min(
        2_147_483_647,
        Math.max(deviceHistoryStreamPolicy.coalesceMs, expiresAt - Date.now()),
      ),
    );
  };
  const unsubscribe = history.subscribe((reports) => {
    const matching = reports.some(
      (report) =>
        Date.parse(report.received_at) >= start &&
        query.kinds.includes(report.kind) &&
        (!query.device_ids || query.device_ids.includes(report.device_id)) &&
        (!query.properties ||
          (report.kind === "property" &&
            query.properties.some(
              (property) =>
                property.device_id === report.device_id &&
                property.siid === report.siid &&
                property.piid === report.piid,
            ))),
    );
    if (!matching || coalescing) return;
    coalescing = setTimeout(() => {
      coalescing = undefined;
      dirty = true;
      wake.resolve();
    }, deviceHistoryStreamPolicy.coalesceMs);
  });
  const aborting = addAbortListener(signal, () => {
    wake.resolve();
  });
  const shared = liveRead.acquire(scope, normalizeDeviceHistoryQuery(query));
  const firstPage = () => {
    assertCurrent();
    return shared.read(signal);
  };
  try {
    let page = await firstPage();
    assertCurrent();
    await send({ event: "page", data: page });
    scheduleExpiry(page);
    while (!signal.aborted) {
      if (!dirty) await wake.promise;
      wake = Promise.withResolvers<void>();
      if (signal.aborted) break;
      if (!dirty) continue;
      dirty = false;
      const next = await firstPage();
      assertCurrent();
      await send({ event: "change", data: pageChanges(page, next) });
      page = next;
      scheduleExpiry(page);
    }
  } finally {
    clearTimeout(coalescing);
    clearTimeout(expiry);
    unsubscribe();
    shared.release();
    aborting[Symbol.dispose]();
  }
}
