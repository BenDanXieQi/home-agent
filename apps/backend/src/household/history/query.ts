import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtempDisposable, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  deviceHistoryQuerySchema,
  deviceHistoryPolicy,
  deviceHistoryObservationSchema,
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

export function normalizeDeviceHistoryQuery(
  input: z.infer<typeof deviceHistoryQuerySchema>,
) {
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
  return {
    ...input,
    kinds: [...new Set(input.kinds)].toSorted(),
    ...(input.device_ids
      ? { device_ids: [...new Set(input.device_ids)].toSorted() }
      : {}),
    ...(properties ? { properties } : {}),
  };
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

/** Assemble complete records within one page's count and byte budgets. */
function createPage(
  input: z.infer<typeof deviceHistoryQuerySchema>,
  transportBytes: (
    response: z.infer<typeof deviceHistoryResponseSchema>,
  ) => number,
) {
  const records: z.infer<
    typeof deviceHistoryResponseSchema
  >["records"][number][] = [];
  let last: string | null = null;
  const response = (more = false) =>
    deviceHistoryResponseSchema.parse({
      account_id: input.account_id,
      home_id: input.home_id,
      start: input.start,
      end: input.end,
      retention_days: deviceHistoryPolicy.retentionDays,
      records,
      next_cursor: more ? last : null,
    });
  const envelopeBytes = transportBytes(response());
  let recordBytes = 0;
  return {
    response,
    append(candidate: unknown, next: string | null) {
      if (records.length === input.limit) return false;
      const record = deviceHistoryObservationSchema.parse(candidate);
      const size = jsonBytes(record) + (records.length ? 1 : 0);
      if (
        envelopeBytes + recordBytes + size + jsonBytes(next) - 4 >
        deviceHistoryPolicy.responseBytes
      ) {
        if (!records.length) throw new HouseholdError("capacity_exceeded");
        return false;
      }
      records.push(record);
      recordBytes += size;
      last = next;
      return true;
    },
  };
}

/** Owns continuation; export consumes one statement snapshot without reopening pages. */
export function createDeviceHistoryQuery(
  repository: ReturnType<typeof createDeviceHistoryRepository>,
) {
  const query = async (
    context: Parameters<typeof repository.read>[0],
    input: z.infer<typeof deviceHistoryQuerySchema>,
    transportBytes: Parameters<typeof createPage>[1],
  ) => {
    context.signal.throwIfAborted();
    context.assertCurrent();
    const normalized = normalizeDeviceHistoryQuery(input);
    const { cursor: _cursor, limit: _limit, ...conditions } = normalized;
    const queryHash = createHash("sha256")
      .update(JSON.stringify(["device_reports", conditions]))
      .digest("hex");
    const cursor = decodeCursor(input.cursor);
    if (cursor && cursor.query !== queryHash)
      throw new AppError("invalid_request");
    const page = createPage(normalized, transportBytes);
    let more = false;
    await repository.read(context, normalized, cursor, (candidate, binding) => {
      const next = Buffer.from(
        JSON.stringify({
          query: queryHash,
          binding,
          position: candidate.position,
        }),
      ).toString("base64url");
      if (!page.append(candidate.record, next)) {
        more = true;
        return false;
      }
      return true;
    });
    context.signal.throwIfAborted();
    context.assertCurrent();
    return page.response(more);
  };
  return Object.assign(query, {
    async export(
      context: Parameters<typeof repository.read>[0],
      input: z.infer<typeof deviceHistoryQuerySchema>,
      transportBytes: Parameters<typeof createPage>[1],
      receive: (
        page: z.infer<typeof deviceHistoryResponseSchema>,
      ) => Promise<void>,
    ) {
      const normalized = normalizeDeviceHistoryQuery({
        ...input,
        cursor: undefined,
        limit: deviceHistoryPolicy.maxLimit,
      });
      // Finish the one database snapshot before waiting for a remote reader.
      await using directory = await mkdtempDisposable(
        join(tmpdir(), "home-agent-device-history-"),
      );
      const path = join(directory.path, "pages.jsonl");
      {
        await using file = await open(path, "wx", 0o600);
        let bytes = 0;
        const save = async (
          page: z.infer<typeof deviceHistoryResponseSchema>,
        ) => {
          context.signal.throwIfAborted();
          context.assertCurrent();
          const line = `${JSON.stringify(page)}\n`;
          bytes += Buffer.byteLength(line);
          if (bytes > deviceHistoryPolicy.exportBytes)
            throw new AppError("device_history_export_too_large");
          await file.writeFile(line, { signal: context.signal });
        };
        let page = createPage(normalized, transportBytes);
        await repository.read(
          context,
          normalized,
          undefined,
          async (candidate) => {
            if (!page.append(candidate.record, null)) {
              await save(page.response());
              page = createPage(normalized, transportBytes);
              page.append(candidate.record, null);
            }
            return true;
          },
          "export",
        );
        await save(page.response());
      }
      await using source = createReadStream(path, { signal: context.signal });
      const lines = createInterface({ input: source, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          context.signal.throwIfAborted();
          context.assertCurrent();
          await receive(deviceHistoryResponseSchema.parse(JSON.parse(line)));
        }
      } finally {
        lines.close();
      }
      context.signal.throwIfAborted();
      context.assertCurrent();
    },
  });
}
