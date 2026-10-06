import { createHash } from "node:crypto";
import { z } from "zod";
import {
  deviceHistoryQuerySchema,
  deviceHistoryPolicy,
  deviceHistoryObservationSchema,
  deviceHistoryRunSchema,
  deviceHistoryResponseSchema,
  deviceHistoryTimeSchema,
} from "@home-agent/api/device-history";
import { AppError } from "@home-agent/api/errors";
import { HouseholdError } from "../errors";
import { jsonBytes } from "../config";
import {
  historyPositionSchema,
  type createDeviceHistoryRepository,
} from "./repository";

const cursorSchema = z.strictObject({
  query: z.string().regex(/^[a-f0-9]{64}$/),
  binding: deviceHistoryTimeSchema,
  position: historyPositionSchema,
});

function normalize(input: z.infer<typeof deviceHistoryQuerySchema>) {
  const properties =
    input.properties &&
    [
      ...new Map(
        input.properties.map((property) => [
          JSON.stringify([property.device_id, property.siid, property.piid]),
          property,
        ]),
      ).values(),
    ].toSorted((a, b) =>
      a.device_id < b.device_id
        ? -1
        : a.device_id > b.device_id
          ? 1
          : a.siid - b.siid || a.piid - b.piid,
    );
  return { ...input, ...(properties ? { properties } : {}) };
}

function decodeCursor(value: string | undefined) {
  if (!value) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
    return cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new AppError("invalid_request");
  }
}

export const historyReadLimits = { submissions: 2 } as const;

/** Owns query admission, continuation and complete-record page assembly. */
export function createDeviceHistoryQuery(
  repository: ReturnType<typeof createDeviceHistoryRepository>,
) {
  let active = 0;
  return async (
    context: Parameters<typeof repository.read>[0],
    input: z.infer<typeof deviceHistoryQuerySchema>,
    transportBytes: (
      response: z.infer<typeof deviceHistoryResponseSchema>,
    ) => number,
  ) => {
    context.signal.throwIfAborted();
    context.assertCurrent();
    const query = normalize(input);
    const queryHash = createHash("sha256")
      .update(
        JSON.stringify([
          "device_reports",
          {
            account_id: query.account_id,
            home_id: query.home_id,
            start: query.start,
            end: query.end,
            representation: query.representation,
            ...(query.properties ? { properties: query.properties } : {}),
          },
        ]),
      )
      .digest("hex");
    const cursor = decodeCursor(input.cursor);
    if (cursor && cursor.query !== queryHash)
      throw new AppError("invalid_request");
    if (active >= historyReadLimits.submissions)
      throw new HouseholdError("capacity_exceeded");
    active++;
    try {
      const records: (
        | z.infer<typeof deviceHistoryObservationSchema>
        | z.infer<typeof deviceHistoryRunSchema>
      )[] = [];
      let last: string | null = null;
      let more = false;
      const envelope = (next: string | null) =>
        deviceHistoryResponseSchema.parse({
          account_id: query.account_id,
          home_id: query.home_id,
          start: query.start,
          end: query.end,
          representation: query.representation,
          retention_days: deviceHistoryPolicy.retentionDays,
          records,
          next_cursor: next,
        });
      const envelopeBytes = transportBytes(envelope(null));
      let recordBytes = 0;
      await repository.read(context, query, cursor, (candidate, binding) => {
        if (records.length === input.limit) {
          more = true;
          return false;
        }
        const record =
          input.representation === "observations"
            ? deviceHistoryObservationSchema.parse(candidate.record)
            : deviceHistoryRunSchema.parse(candidate.record);
        const next = Buffer.from(
          JSON.stringify({
            query: queryHash,
            binding,
            position: candidate.position,
          }),
        ).toString("base64url");
        const nextRecordBytes = jsonBytes(record) + (records.length ? 1 : 0);
        const cursorBytes = jsonBytes(next) - 4;
        if (
          envelopeBytes + recordBytes + nextRecordBytes + cursorBytes >
          deviceHistoryPolicy.responseBytes
        ) {
          if (!records.length) throw new HouseholdError("capacity_exceeded");
          more = true;
          return false;
        }
        records.push(record);
        recordBytes += nextRecordBytes;
        last = next;
        return true;
      });
      context.signal.throwIfAborted();
      context.assertCurrent();
      return envelope(more ? last : null);
    } finally {
      // Cancellation never frees admission before the driver has ended the transaction.
      active--;
    }
  };
}
