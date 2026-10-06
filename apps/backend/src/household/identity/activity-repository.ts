import { and, eq, gt, gte, inArray, lt, or, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { memberActivityDataSchema } from "@home-agent/api/contracts";
import {
  memberSightingRecordSchema,
  memberSightingsHistoryQuerySchema,
} from "@home-agent/api/agent-context";
import { memberObservationSchema } from "@home-agent/api/agent-context/observations";
import { AppError } from "@home-agent/api/errors";
import type { Database } from "../../db";
import {
  contextEntities,
  contextRecords,
  mijiaHomeSelections,
} from "../../db/schema";
import type { Transaction } from "../../db/transaction-outcome";
import {
  createHouseholdBindingAccess,
  createHouseholdBindingRead,
} from "../binding-repository";
import {
  createMemberWriter,
  lockIdentityMembers,
  membersLock,
} from "./repository";
import type { memberActivity } from "./activity";

const memberSightingTopic = sql`${contextRecords.topic} = 'member_sighting'`;

export const memberSightingPositionSchema = z.strictObject({
  firstObservedAt: memberActivityDataSchema.shape.firstObservedAt,
  id: z.uuid(),
});

async function sightingRecords(
  tx: Transaction,
  rows: (typeof contextRecords.$inferSelect)[],
) {
  const entities = rows.length
    ? await tx
        .select()
        .from(contextEntities)
        .where(
          inArray(
            contextEntities.contextId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(
          contextEntities.contextId,
          contextEntities.entityType,
          contextEntities.entityId,
          contextEntities.role,
        )
    : [];
  const byRecord = Map.groupBy(entities, (entity) => entity.contextId);
  return rows.map((row) =>
    memberSightingRecordSchema.parse({
      ...row,
      occurredAt: row.occurredAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      entities: byRecord.get(row.id) ?? [],
    }),
  );
}

async function bindingUpdatedAt(tx: Transaction) {
  const [binding] = await tx
    .select({
      updatedAt: sql<string>`to_char(${mijiaHomeSelections.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(mijiaHomeSelections)
    .limit(1);
  return binding!.updatedAt;
}

export function createMemberActivityRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  const read = createHouseholdBindingRead(db);
  const write = createMemberWriter(db);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error("Member activity repository subscriber failed", error);
      }
    }
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => write.close(),
    binding(identity: Parameters<typeof access>[0], assertCurrent: () => void) {
      return access(identity, assertCurrent, bindingUpdatedAt);
    },
    async byId(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      id: string,
    ) {
      return access(identity, assertCurrent, async (tx) => {
        await lockIdentityMembers(tx, "shared");
        const rows = await tx
          .select()
          .from(contextRecords)
          .where(and(memberSightingTopic, eq(contextRecords.id, id)))
          .limit(1);
        return (await sightingRecords(tx, rows))[0] ?? null;
      });
    },
    async currentObservations(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      since: number,
      consume: (record: z.infer<typeof memberObservationSchema>) => boolean,
    ) {
      return read(identity, assertCurrent, async (tx) => {
        await tx`select pg_advisory_xact_lock_shared(hashtextextended(${membersLock}, 0))`;
        assertCurrent();
        const query = tx`
          with ranked as materialized (
            select id, (data->>'lastObservedAt')::numeric as observed_at, dense_rank() over (
              partition by case when data #>> '{attribution,current,kind}' = 'known'
                then jsonb_build_array('member', data #>> '{attribution,current,association,memberId}')
                else jsonb_build_array('unknown', data->>'deviceId', data->>'channel') end
              order by (data->>'lastObservedAt')::numeric desc
            ) as position
            from context_records where topic = 'member_sighting'
          )
          select context_records.id, jsonb_build_object(
            'sourceRunId', data->'sourceRunId',
            'run', data->'run',
            'mediaGeneration', data->'mediaGeneration',
            'trackId', data->'trackId',
            'deviceId', data->'deviceId',
            'channel', data->'channel',
            'firstObservedAt', data->'firstObservedAt',
            'lastObservedAt', data->'lastObservedAt'
          ) as data,
          case when data #>> '{attribution,current,kind}' = 'known' then
            jsonb_build_object(
              'kind', 'known',
              'association', jsonb_build_object(
                'memberId', data #> '{attribution,current,association,memberId}',
                'state', data #> '{attribution,current,association,state}'
              )
            )
          else jsonb_build_object(
            'kind', data #> '{attribution,current,kind}'
          ) end as attribution,
          (data #>> '{attribution,revision}')::integer as revision
          from ranked join context_records on context_records.id = ranked.id
          where ranked.position = 1 or ranked.observed_at >= ${since}
          order by ranked.observed_at desc, context_records.id desc
        `;
        for await (const rows of query.cursor(16)) {
          for (const row of rows) {
            assertCurrent();
            if (!consume(memberObservationSchema.parse(row))) return false;
          }
        }
        return true;
      });
    },
    async history(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      input: ReturnType<typeof memberSightingsHistoryQuerySchema.parse>,
      after?: {
        bindingUpdatedAt: string;
        position: ReturnType<typeof memberSightingPositionSchema.parse>;
      },
    ) {
      return access(identity, assertCurrent, async (tx) => {
        await lockIdentityMembers(tx, "shared");
        const bindingTime = await bindingUpdatedAt(tx);
        if (after && after.bindingUpdatedAt !== bindingTime)
          throw new AppError("invalid_request");
        const firstObservedAt = sql<number>`(${contextRecords.data}->>'firstObservedAt')::numeric`;
        const lastObservedAt = sql<number>`(${contextRecords.data}->>'lastObservedAt')::numeric`;
        const memberId = sql<string>`${contextRecords.data} #>> '{attribution,current,association,memberId}'`;
        const sourceDeviceId = sql<string>`${contextRecords.data}->>'deviceId'`;
        const sourceChannel = sql<string>`${contextRecords.data}->>'channel'`;
        const rows = await tx
          .select()
          .from(contextRecords)
          .where(
            and(
              memberSightingTopic,
              lt(
                firstObservedAt,
                sql`extract(epoch from ${input.end}::timestamptz) * 1000`,
              ),
              gte(
                lastObservedAt,
                sql`extract(epoch from ${input.start}::timestamptz) * 1000`,
              ),
              input.member_ids &&
                and(
                  sql`${contextRecords.data} #>> '{attribution,current,kind}' = 'known'`,
                  inArray(memberId, input.member_ids),
                ),
              input.sources &&
                or(
                  ...input.sources.map((source) =>
                    and(
                      eq(sourceDeviceId, source.device_id),
                      source.channel === undefined
                        ? undefined
                        : eq(sourceChannel, String(source.channel)),
                    ),
                  ),
                ),
              after &&
                or(
                  gt(firstObservedAt, after.position.firstObservedAt),
                  and(
                    eq(firstObservedAt, after.position.firstObservedAt),
                    gt(contextRecords.id, after.position.id),
                  ),
                ),
            ),
          )
          .orderBy(firstObservedAt, contextRecords.id)
          .limit(input.limit + 1);
        return {
          records: await sightingRecords(tx, rows),
          bindingUpdatedAt: bindingTime,
        };
      });
    },
    async save(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      activity: ReturnType<typeof memberActivity>,
    ) {
      // Validate the shared JSON boundary before acquiring storage resources.
      const data = memberActivityDataSchema.parse(activity.record.data);
      const current = data.attribution.current;
      if (
        data.sourceRunId !== data.run.runId ||
        activity.record.scopeEpoch !== data.run.scopeEpoch ||
        data.deviceId !== data.run.deviceId ||
        data.channel !== data.run.channel
      )
        throw new Error("Member activity source identity mismatch");
      if (current.kind === "known") {
        const association = current.association;
        if (
          !isDeepStrictEqual(association.run, data.run) ||
          association.sourceRunId !== data.run.runId ||
          association.mediaGeneration !== data.mediaGeneration ||
          association.trackId !== data.trackId
        )
          throw new Error("Member activity target identity mismatch");
      } else {
        const correction = data.attribution.lastCorrection;
        if (
          !correction ||
          correction.reason !== current.reason ||
          !isDeepStrictEqual(correction.after, current) ||
          correction.before.kind !== "known" ||
          correction.before.association.basis !== "appearance" ||
          !current.trigger.referenceIds.some(
            (id) =>
              correction.before.kind === "known" &&
              correction.before.association.basis === "appearance" &&
              correction.before.association.referenceIds.includes(id),
          )
        )
          throw new Error("Member activity revocation lacks domain evidence");
        if (current.reason === "target_face_conflict") {
          const trigger = current.trigger;
          if (
            trigger.reason !== "target_face_conflict" ||
            trigger.sourceTargetKey !==
              JSON.stringify([
                data.run.scopeEpoch,
                data.run.runId,
                data.mediaGeneration,
                data.trackId,
              ]) ||
            !trigger.trigger ||
            !isDeepStrictEqual(trigger.trigger.observation.run, data.run) ||
            trigger.trigger.observation.mediaTime.generation !==
              data.mediaGeneration ||
            trigger.trigger.track.trackId !== data.trackId ||
            trigger.trigger.track.state !== "conflict"
          )
            throw new Error(
              "Member activity conflict target identity mismatch",
            );
        } else if (current.trigger.reason === "target_face_conflict")
          throw new Error(
            "Member activity reference revocation reason mismatch",
          );
      }
      return write(
        identity,
        assertCurrent,
        async (tx, beforeWrite) => {
          const [saved] = await tx
            .select()
            .from(contextRecords)
            .where(eq(contextRecords.id, activity.record.id))
            .for("update");
          const previous = saved && memberActivityDataSchema.parse(saved.data);
          if (saved && previous) {
            const immutable = (value: typeof data) => ({
              run: value.run,
              mediaGeneration: value.mediaGeneration,
              trackId: value.trackId,
              deviceId: value.deviceId,
              channel: value.channel,
              firstObservedAt: value.firstObservedAt,
              original: value.attribution.original,
            });
            if (
              saved.topic !== activity.record.topic ||
              saved.kind !== activity.record.kind ||
              saved.scopeEpoch !== activity.record.scopeEpoch ||
              saved.occurredAt.getTime() !==
                activity.record.occurredAt.getTime() ||
              !isDeepStrictEqual(immutable(previous), immutable(data))
            )
              throw new Error("Member activity immutable identity conflict");
            if (data.attribution.revision < previous.attribution.revision)
              return {
                status: "obsolete" as const,
                revision: previous.attribution.revision,
              };
            if (data.attribution.revision === previous.attribution.revision) {
              if (
                !isDeepStrictEqual(previous, data) ||
                saved.summary !== activity.record.summary ||
                saved.certainty !== activity.record.certainty ||
                !isDeepStrictEqual(saved.evidence, activity.record.evidence)
              )
                throw new Error("Member activity revision content conflict");
              return {
                status: "saved" as const,
                revision: data.attribution.revision,
              };
            }
            if (
              data.attribution.correctionCount <
              previous.attribution.correctionCount
            )
              throw new Error("Member activity correction count decreased");
          }
          // The activity owner checks live member/reference eligibility here,
          // under the same lock used to revoke matching before member mutations.
          assertCurrent();
          beforeWrite();
          if (!saved)
            await tx
              .insert(contextRecords)
              .values({ ...activity.record, data });
          else
            await tx
              .update(contextRecords)
              .set({
                data,
                summary: activity.record.summary,
                certainty: activity.record.certainty,
                evidence: activity.record.evidence,
              })
              .where(eq(contextRecords.id, activity.record.id));
          await tx
            .delete(contextEntities)
            .where(
              and(
                eq(contextEntities.contextId, activity.record.id),
                eq(contextEntities.role, "subject"),
              ),
            );
          await tx
            .insert(contextEntities)
            .values([
              ...(current.kind === "known"
                ? [
                    {
                      contextId: activity.record.id,
                      entityType: current.association.memberKind,
                      entityId: current.association.memberId,
                      role: "subject" as const,
                    },
                  ]
                : []),
              {
                contextId: activity.record.id,
                entityType: "device" as const,
                entityId: data.deviceId,
                role: "source" as const,
              },
            ])
            .onConflictDoNothing();
          assertCurrent();
          return {
            status: "saved" as const,
            revision: data.attribution.revision,
          };
        },
        async (tx) => {
          const [stored] = await tx
            .select()
            .from(contextRecords)
            .where(eq(contextRecords.id, activity.record.id));
          return stored &&
            stored.scopeEpoch === activity.record.scopeEpoch &&
            stored.kind === activity.record.kind &&
            stored.topic === activity.record.topic &&
            stored.occurredAt.getTime() ===
              activity.record.occurredAt.getTime() &&
            stored.summary === activity.record.summary &&
            stored.certainty === activity.record.certainty &&
            isDeepStrictEqual(stored.data, data) &&
            isDeepStrictEqual(stored.evidence, activity.record.evidence)
            ? {
                committed: true,
                value: {
                  status: "saved" as const,
                  revision: data.attribution.revision,
                },
              }
            : { committed: false };
        },
        (result) => {
          if (result.committed) notify();
        },
      );
    },
  };
}
