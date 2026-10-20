import { recordPruneBatchSize } from "../records/retention";
import { provenanceQueryHash } from "../records/query";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  provenancePolicy,
  materialRecordSchema,
  materialSummarySchema,
  materialQueryResponseSchema,
  materialTopicSchema,
  supplierMaterialSchema,
  type provenanceQuerySchema,
} from "@home-agent/api/action-provenance";
import type { Database } from "../../db";
import { contextRecords, contextEntities } from "../../db/schema";
import { createHouseholdBindingAccess } from "../binding-repository";
import type { accessHousehold } from "../access";
import { jsonBytes } from "../config";
import { HouseholdError } from "../errors";

type Scope = ReturnType<typeof accessHousehold>;
type ReadScope = Pick<Scope, "identity" | "assertCurrent">;
export function createMaterialRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  const table = contextRecords;
  const retainedMaterials = () =>
    and(
      sql`${table.kind} = 'observation'`,
      inArray(table.topic, materialTopicSchema.options),
      sql`${table.expiresAt} > now()`,
    );
  return {
    async save(
      scope: Scope,
      submission: {
        id: string;
        received_at: string;
        data: ReturnType<typeof supplierMaterialSchema.parse>;
      },
      retentionDays: number,
    ) {
      const data = supplierMaterialSchema.parse(submission.data);
      if (jsonBytes(data) > provenancePolicy.recordBytes)
        throw new HouseholdError("capacity_exceeded");
      const providerIdentity =
        data.topic === "xiaoai_conversation"
          ? [data.speaker_id, data.request_id]
          : data.topic === "mijia_scene_execution"
            ? [data.execution_id]
            : data.topic === "mijia_device_history"
              ? [data.device_id, data.source.endpoint, data.record_id]
              : null;
      const sourceKey = providerIdentity
        ? JSON.stringify([data.topic, ...providerIdentity])
        : null;
      return access(scope.identity, scope.assertCurrent, async (tx) => {
        const inserted = await tx
          .insert(table)
          .values({
            id: submission.id,
            kind: "observation",
            topic: data.topic,
            summary:
              data.topic === "miot_event"
                ? `MIoT 设备事件 ${data.siid}.${data.eiid}`
                : data.topic === "xiaoai_conversation"
                  ? `小爱音箱对话（${data.hardware}）`
                  : data.topic === "mijia_scene_execution"
                    ? "米家场景执行记录"
                    : "米家设备云端历史记录",
            data,
            certainty: "supported",
            occurredAt: new Date(submission.received_at),
            expiresAt: new Date(
              Date.parse(submission.received_at) + retentionDays * 86400_000,
            ),
            sourceOccurredAt: data.source.source_time
              ? new Date(data.source.source_time)
              : null,
            scopeEpoch: scope.snapshot.scope_epoch,
            evidence: data.source.message_id
              ? [
                  {
                    provider: data.source.provider,
                    endpoint: data.source.endpoint,
                    message_id: data.source.message_id,
                  },
                ]
              : [],
            sourceKey,
          })
          .onConflictDoNothing()
          .returning({ id: table.id });
        if (!inserted.length) return { inserted: false };
        const devices =
          data.topic === "mijia_scene_execution"
            ? data.targets.map((target) => target.device_id)
            : [data.device_id];
        if (devices.length)
          await tx.insert(contextEntities).values(
            [...new Set(devices)].map((id) => ({
              contextId: submission.id,
              entityType: "device" as const,
              entityId: id,
              role:
                data.topic === "mijia_scene_execution"
                  ? ("participant" as const)
                  : ("source" as const),
            })),
          );
        if (data.room_id)
          await tx.insert(contextEntities).values({
            contextId: submission.id,
            entityType: "room",
            entityId: data.room_id,
            role: "location",
          });
        return { inserted: true };
      });
    },
    async query(
      scope: ReadScope,
      input: ReturnType<typeof provenanceQuerySchema.parse>,
    ) {
      const queryHash = provenanceQueryHash("materials", input);
      return access(scope.identity, scope.assertCurrent, async (tx) => {
        const time =
          input.time_basis === "source"
            ? table.sourceOccurredAt
            : table.occurredAt;
        const rows = await tx
          .select({
            id: table.id,
            topic: table.topic,
            summary: table.summary,
            occurred_at: table.occurredAt,
            expires_at: table.expiresAt,
            created_at: table.createdAt,
            kind: table.kind,
            certainty: table.certainty,
            source_time: sql<
              string | null
            >`${table.data}->'source'->>'source_time'`,
            source: sql<string>`${table.data}->'source'->>'endpoint'`,
            device_id: sql<string | null>`${table.data}->>'device_id'`,
            speaker_id: sql<string | null>`${table.data}->>'speaker_id'`,
            scene_id: sql<string | null>`${table.data}->>'scene_id'`,
            completeness: sql<string>`${table.data}->'source'->>'completeness'`,
            at: sql<string>`to_char(${time} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(table)
          .where(
            and(
              retainedMaterials(),
              sql`${time} >= ${input.start}::timestamptz and ${time} < ${input.end}::timestamptz`,
              input.topic ? eq(table.topic, input.topic) : undefined,
              input.device_id
                ? inArray(
                    table.id,
                    tx
                      .select({ id: contextEntities.contextId })
                      .from(contextEntities)
                      .where(
                        and(
                          eq(contextEntities.entityType, "device"),
                          eq(contextEntities.entityId, input.device_id),
                        ),
                      ),
                  )
                : undefined,
              input.scene_id
                ? sql`${table.data}->>'scene_id' = ${input.scene_id}`
                : undefined,
              input.speaker_id
                ? sql`${table.data}->>'speaker_id' = ${input.speaker_id}`
                : undefined,
              input.source
                ? sql`${table.data}->'source'->>'endpoint' = ${input.source}`
                : undefined,
              input.cursor
                ? sql`(${time}, ${table.id}) > (${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)`
                : undefined,
            ),
          )
          .orderBy(time, table.id)
          .limit(input.limit + 1);
        const records: ReturnType<typeof materialSummarySchema.parse>[] = [];
        let bytes = 512;
        for (const row of rows.slice(0, input.limit)) {
          const record = materialSummarySchema.parse({
            ...row,
            received_at: row.occurred_at.toISOString(),
            created_at: row.created_at.toISOString(),
            expires_at: row.expires_at?.toISOString(),
          });
          const size = jsonBytes(record) + 1;
          if (bytes + size > provenancePolicy.responseBytes) break;
          records.push(record);
          bytes += size;
        }
        if (rows.length && !records.length)
          throw new HouseholdError("capacity_exceeded");
        const last = records.at(-1);
        return materialQueryResponseSchema.parse({
          records,
          next_cursor:
            last && records.length < rows.length
              ? {
                  at: rows[records.length - 1]!.at,
                  id: last.id,
                  query_hash: queryHash,
                }
              : null,
          time_basis: input.time_basis,
          complete_history: false,
        });
      });
    },
    async read(scope: ReadScope, id: string) {
      return access(scope.identity, scope.assertCurrent, async (tx) => {
        const [row] = await tx
          .select()
          .from(table)
          .where(and(retainedMaterials(), eq(table.id, id)))
          .limit(1);
        return row
          ? materialRecordSchema.parse({
              id: row.id,
              kind: row.kind,
              topic: row.topic,
              summary: row.summary,
              certainty: row.certainty,
              received_at: row.occurredAt.toISOString(),
              created_at: row.createdAt.toISOString(),
              expires_at: row.expiresAt?.toISOString(),
              data: row.data,
              evidence: row.evidence,
            })
          : null;
      });
    },
    async pruneRecords() {
      return db.transaction(async (tx) => {
        const expired = await tx
          .select({ id: table.id, sourceKey: table.sourceKey })
          .from(table)
          .where(
            and(
              inArray(table.topic, materialTopicSchema.options),
              sql`${table.expiresAt} <= now()`,
            ),
          )
          .orderBy(table.expiresAt, table.id)
          .limit(recordPruneBatchSize)
          .for("update", { skipLocked: true });
        const identities = expired
          .filter((row) => row.sourceKey !== null)
          .map((row) => row.id);
        const events = expired
          .filter((row) => row.sourceKey === null)
          .map((row) => row.id);
        if (identities.length) {
          await tx
            .update(table)
            .set({
              topic: "supplier_material_identity",
              summary: "供应商材料去重身份（正文已到期）",
              data: {},
              evidence: [],
              sourceOccurredAt: null,
            })
            .where(inArray(table.id, identities));
          await tx
            .delete(contextEntities)
            .where(inArray(contextEntities.contextId, identities));
        }
        if (events.length)
          await tx.delete(table).where(inArray(table.id, events));
        return expired.length;
      });
    },
  };
}
