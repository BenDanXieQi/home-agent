import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  lt,
  lte,
  or,
  sql,
  DrizzleQueryError,
} from "drizzle-orm";
import postgres from "postgres";
import {
  windowSummarySchema,
  type windowListQuerySchema,
  type perceptionWindowsHistoryQuerySchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import type { Database } from "../../db";
import { createHouseholdBindingAccess } from "../../household/binding-repository";
import { perceptionWindows as records } from "./schema";
import { HouseholdError } from "../../household/errors";

const connectionErrorCodes = new Set([
  "CONNECTION_ENDED",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
]);

function storageFailure(error: unknown) {
  while (error instanceof DrizzleQueryError) error = error.cause;
  return (
    error instanceof postgres.PostgresError ||
    (error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      connectionErrorCodes.has(error.code))
  );
}

export function createWindowHistoryRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  const read = async <T>(
    identity: Parameters<typeof access>[0],
    assertCurrent: () => void,
    run: Parameters<typeof access<T>>[2],
  ) => {
    try {
      return await access(identity, assertCurrent, run);
    } catch (error) {
      assertCurrent();
      if (storageFailure(error)) throw new HouseholdError("home_storage");
      throw error;
    }
  };
  const within = (identity: Parameters<typeof access>[0]) =>
    and(
      eq(records.accountId, identity.accountId),
      eq(records.homeId, identity.homeId ?? ""),
      gt(records.expiresAt, Date.now()),
    );
  return {
    save(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      summary: z.infer<typeof windowSummarySchema>,
    ) {
      const intervals = [
        [summary.startedAt, summary.endedAt],
        ...(summary.audio.run &&
        summary.audio.startedAt !== null &&
        summary.audio.endedAt !== null
          ? [[summary.audio.startedAt, summary.audio.endedAt]]
          : []),
        ...summary.speech.segments.map((segment) => [
          segment.observedStartAt,
          segment.observedEndAt,
        ]),
      ];
      const observed = {
        observedStartAt: Math.min(...intervals.map((interval) => interval[0]!)),
        observedEndAt: Math.max(...intervals.map((interval) => interval[1]!)),
      };
      return access(identity, assertCurrent, async (tx) => {
        await tx
          .insert(records)
          .values({
            id: summary.id,
            ...identity,
            homeId: identity.homeId ?? "",
            deviceId: summary.run.deviceId,
            channel: summary.run.channel,
            startedAt: summary.startedAt,
            endedAt: summary.endedAt,
            expiresAt: summary.summaryUntil,
            summary,
            ...observed,
          })
          .onConflictDoUpdate({
            target: records.id,
            set: { summary, ...observed },
            setWhere: sql`(${records.summary}->>'revision')::integer <= ${summary.revision}`,
          });
      });
    },
    get(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      id: string,
    ) {
      return read(identity, assertCurrent, async (tx) => {
        const [row] = await tx
          .select({ summary: records.summary })
          .from(records)
          .where(and(within(identity), eq(records.id, id)))
          .limit(1);
        return row && windowSummarySchema.parse(row.summary);
      });
    },
    list(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      query: z.infer<typeof windowListQuerySchema>,
    ) {
      return read(identity, assertCurrent, async (tx) => {
        const rows = await tx
          .select({ summary: records.summary })
          .from(records)
          .where(
            and(
              within(identity),
              eq(records.deviceId, query.deviceId),
              eq(records.channel, query.channel),
              query.start === undefined
                ? undefined
                : gte(records.startedAt, query.start),
              query.end === undefined
                ? undefined
                : lt(records.startedAt, query.end),
              query.before === undefined
                ? undefined
                : query.beforeId
                  ? sql`(${records.startedAt}, ${records.id}) < (${query.before}, ${query.beforeId}::uuid)`
                  : lt(records.startedAt, query.before),
            ),
          )
          .orderBy(desc(records.startedAt), desc(records.id))
          .limit(51);
        return rows.map((row) => windowSummarySchema.parse(row.summary));
      });
    },
    history(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      input: Pick<
        z.infer<typeof perceptionWindowsHistoryQuerySchema>,
        "start" | "end" | "sources" | "limit"
      >,
      after?: Pick<z.infer<typeof windowSummarySchema>, "startedAt" | "id">,
    ) {
      const start = sql`(extract(epoch from ${input.start}::timestamptz) * 1000)`;
      const end = sql`(extract(epoch from ${input.end}::timestamptz) * 1000)`;
      return read(identity, assertCurrent, async (tx) => {
        const rows = await tx
          .select({ summary: records.summary })
          .from(records)
          .where(
            and(
              within(identity),
              input.sources
                ? or(
                    ...input.sources.map((source) =>
                      and(
                        eq(records.deviceId, source.device_id),
                        source.channel === undefined
                          ? undefined
                          : eq(records.channel, source.channel),
                      ),
                    ),
                  )
                : undefined,
              after
                ? sql`(${records.startedAt}, ${records.id}) > (${after.startedAt}, ${after.id}::uuid)`
                : undefined,
              sql`numrange(${records.observedStartAt}, ${records.observedEndAt}, '[]') && numrange(${start}, ${end}, '[)')`,
              or(
                and(lt(records.startedAt, end), gte(records.endedAt, start)),
                sql`((${records.summary}->'audio'->>'startedAt')::numeric < ${end} and (${records.summary}->'audio'->>'endedAt')::numeric >= ${start})`,
                sql`exists (select 1 from jsonb_array_elements(${records.summary}->'speech'->'segments') segment where (segment->>'observedStartAt')::numeric < ${end} and (segment->>'observedEndAt')::numeric >= ${start})`,
              ),
            ),
          )
          .orderBy(asc(records.startedAt), asc(records.id))
          .limit(input.limit + 1);
        return rows.map((row) => windowSummarySchema.parse(row.summary));
      });
    },
    async prune() {
      await db
        .delete(records)
        .where(
          sql`${records.id} in (select id from ${records} where ${lte(records.expiresAt, Date.now())} limit 1000)`,
        );
    },
  };
}
