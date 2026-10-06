import { replaceEqualDeep } from "@tanstack/query-core";
import {
  deviceHistoryQuerySchema,
  deviceHistoryResponseSchema,
  deviceHistoryChangeSchema,
  deviceHistoryRecordId,
} from "@home-agent/api/device-history";
import { RequestError } from "../../api/errors";

export type HistoryQuery = ReturnType<typeof deviceHistoryQuerySchema.parse>;
export type HistoryResponse = ReturnType<
  typeof deviceHistoryResponseSchema.parse
>;

function shareRecords<Record extends HistoryResponse["records"][number]>(
  previous: readonly Record[],
  records: readonly Record[],
) {
  const known = new Map(
    previous.map((record) => [deviceHistoryRecordId(record), record]),
  );
  return records.map((record) =>
    replaceEqualDeep(known.get(deviceHistoryRecordId(record)), record),
  );
}

export function shareHistoryPage(
  previous: HistoryResponse | undefined,
  page: HistoryResponse,
) {
  return {
    ...page,
    records: shareRecords(previous?.records ?? [], page.records),
  };
}

function changedRecords<Record extends HistoryResponse["records"][number]>(
  previous: readonly Record[],
  change: Pick<
    ReturnType<typeof deviceHistoryChangeSchema.parse>,
    "record_ids" | "removed_ids"
  > & { records: readonly Record[] },
) {
  const records = new Map(
    previous.map((record) => [deviceHistoryRecordId(record), record]),
  );
  for (const id of change.removed_ids) records.delete(id);
  for (const record of change.records)
    records.set(deviceHistoryRecordId(record), record);
  if (records.size !== change.record_ids.length)
    throw new RequestError({ code: "invalid_response" });
  return change.record_ids.map((id) => {
    const record = records.get(id);
    if (!record) throw new RequestError({ code: "invalid_response" });
    return record;
  });
}

/** Replace page order while sharing unchanged records. */
export function applyHistoryChange(
  previous: HistoryResponse,
  change: ReturnType<typeof deviceHistoryChangeSchema.parse>,
) {
  if (
    previous.account_id !== change.account_id ||
    previous.home_id !== change.home_id ||
    previous.start !== change.start
  )
    throw new RequestError({ code: "invalid_response" });
  const { record_ids: _ids, removed_ids: _removed, ...page } = change;
  return shareHistoryPage(previous, {
    ...page,
    records: changedRecords(previous.records, change),
  });
}

function appendRecords<Record extends HistoryResponse["records"][number]>(
  previous: readonly Record[],
  next: readonly Record[],
) {
  const ids = new Set(previous.map(deviceHistoryRecordId));
  return [
    ...previous,
    ...next.filter((record) => !ids.has(deviceHistoryRecordId(record))),
  ];
}

/** Append a continuation without duplicating records already loaded. */
export function appendHistoryPage(
  previous: HistoryResponse,
  page: HistoryResponse,
) {
  if (
    previous.account_id !== page.account_id ||
    previous.home_id !== page.home_id ||
    previous.start !== page.start
  )
    throw new RequestError({ code: "invalid_response" });
  return { ...page, records: appendRecords(previous.records, page.records) };
}
