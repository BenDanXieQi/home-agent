import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
  DrizzleQueryError,
} from "drizzle-orm";
import postgres from "postgres";
import {
  windowSummarySchema,
  windowMarkerSchema,
  windowHistoryRetentionMs,
  type windowListQuerySchema,
  type perceptionWindowsHistoryQuerySchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import type { Database } from "../../db";
import { createHouseholdBindingAccess } from "../../household/binding-repository";
import {
  perceptionMarkers as markers,
  perceptionWindows as records,
} from "./schema";
import { HouseholdError } from "../../household/errors";
import { lockTransaction } from "../../db/transaction-outcome";
import { readMemberActivitiesInRange } from "../../household/identity/activity-repository";

const markerLock = (deviceId: string, channel: number) =>
  JSON.stringify(["perception_markers", deviceId, channel]);

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
        await lockTransaction(
          tx,
          markerLock(summary.run.deviceId, summary.run.channel),
          "exclusive",
        );
        await tx
          .insert(records)
          .values({
            id: summary.id,
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

        const startedAt = Math.max(
          summary.startedAt,
          Date.now() - windowHistoryRetentionMs,
        );
        if (summary.endedAt <= startedAt) return;
        const overlapping = await tx
          .select()
          .from(markers)
          .where(
            and(
              eq(markers.deviceId, summary.run.deviceId),
              eq(markers.channel, summary.run.channel),
              sql`numrange(${markers.startedAt}, ${markers.endedAt}, '[]') && numrange(${startedAt}, ${summary.endedAt}, '[]')`,
            ),
          )
          .orderBy(asc(markers.startedAt), asc(markers.id));
        const first = overlapping[0];
        const marker = {
          id: first?.id ?? crypto.randomUUID(),
          deviceId: summary.run.deviceId,
          channel: summary.run.channel,
          startedAt: Math.min(
            startedAt,
            ...overlapping.map((entry) => entry.startedAt),
          ),
          endedAt: Math.max(
            summary.endedAt,
            ...overlapping.map((entry) => entry.endedAt),
          ),
        };
        if (
          overlapping.length === 1 &&
          first?.startedAt === marker.startedAt &&
          first.endedAt === marker.endedAt
        )
          return;
        if (overlapping.length)
          await tx.delete(markers).where(
            inArray(
              markers.id,
              overlapping.map((entry) => entry.id),
            ),
          );
        await tx.insert(markers).values(marker);
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
          .where(and(gt(records.expiresAt, Date.now()), eq(records.id, id)))
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
        const cutoff = Date.now() - windowHistoryRetentionMs;
        const startedAt =
          sql<number>`greatest(${markers.startedAt}, ${cutoff})`.mapWith(
            Number,
          );
        const overlapping = and(
          eq(records.deviceId, markers.deviceId),
          eq(records.channel, markers.channel),
          lt(records.startedAt, markers.endedAt),
          gt(records.endedAt, startedAt),
          gt(records.expiresAt, Date.now()),
        );
        const observation = tx
          .select({ summary: records.summary })
          .from(records)
          .where(overlapping)
          .orderBy(asc(records.startedAt), asc(records.id))
          .limit(1);
        const detectedClasses = tx
          .select({
            classes: sql`coalesce(jsonb_agg(distinct detection.class_name), '[]'::jsonb)`,
          })
          .from(records)
          .innerJoin(
            sql`jsonb_array_elements(
              jsonb_path_query_array(${records.summary}, '$.frames[*].tracks[*] ? (@.state == "measured").className') ||
              jsonb_path_query_array(${records.summary}, '$.frames[*].detections[*].className')
            ) as detection(class_name)`,
            sql`detection.class_name in ('"human"'::jsonb, '"cat"'::jsonb, '"dog"'::jsonb)`,
          )
          .where(overlapping);
        const spans = await tx
          .select({
            id: markers.id,
            startedAt,
            endedAt: markers.endedAt,
            observation: sql`(${observation})`,
            detectedClasses: sql`(${detectedClasses})`,
          })
          .from(markers)
          .where(
            and(
              eq(markers.deviceId, query.deviceId),
              eq(markers.channel, query.channel),
              gt(markers.endedAt, cutoff),
              query.start === undefined
                ? undefined
                : gt(markers.endedAt, query.start),
              query.end === undefined ? undefined : lt(startedAt, query.end),
              query.before === undefined
                ? undefined
                : query.beforeId
                  ? sql`(${startedAt}, ${markers.id}) < (${query.before}, ${query.beforeId}::uuid)`
                  : lt(startedAt, query.before),
            ),
          )
          .orderBy(desc(markers.startedAt), desc(markers.id))
          .limit(51);
        const activities = spans.length
          ? await readMemberActivitiesInRange(
              tx,
              query,
              Math.min(...spans.map((row) => row.startedAt)),
              Math.max(...spans.map((row) => row.endedAt)),
            )
          : [];
        return spans.map((row) => {
          const attributions = new Map(
            activities
              .filter(
                (activity) =>
                  activity.firstObservedAt < row.endedAt &&
                  activity.lastObservedAt >= row.startedAt,
              )
              .map(({ attribution: { current } }) => [
                current.kind === "known"
                  ? current.association.memberId
                  : "unknown",
                current,
              ]),
          );
          return windowMarkerSchema.parse({
            ...row,
            memberAttributions: [...attributions.values()],
          });
        });
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
              gt(records.expiresAt, Date.now()),
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

      const cutoff = Date.now() - windowHistoryRetentionMs;
      const sources = await db
        .selectDistinct({
          deviceId: markers.deviceId,
          channel: markers.channel,
        })
        .from(markers)
        .where(lt(markers.startedAt, cutoff));
      for (const source of sources)
        await db.transaction(async (tx) => {
          await lockTransaction(
            tx,
            markerLock(source.deviceId, source.channel),
            "exclusive",
          );
          const current = and(
            eq(markers.deviceId, source.deviceId),
            eq(markers.channel, source.channel),
          );
          await tx
            .delete(markers)
            .where(and(current, lte(markers.endedAt, cutoff)));
          await tx
            .update(markers)
            .set({ startedAt: cutoff })
            .where(and(current, lt(markers.startedAt, cutoff)));
        });
    },
  };
}
