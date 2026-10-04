import {
  and,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  contextBrowseResponseSchema,
  contextCursorSchema,
  contextTableSchema,
  type contextBrowseQuerySchema,
} from "@home-agent/api/household-context";
import type { Database } from "../db";
import {
  contextEntities,
  contextRecords,
  householdSubjects,
} from "../db/schema";
import { createHouseholdBindingAccess } from "../household/binding-repository";
import { HouseholdError } from "../household/errors";
import { jsonBytes } from "../household/config";

const tables = {
  household_subjects: householdSubjects,
  context_records: contextRecords,
  context_entities: contextEntities,
};
const pageSize = 25;
const metadata = contextTableSchema.options.map((name) => {
  const table = tables[name];
  const config = getTableConfig(table);
  return {
    name,
    columns: Object.entries(getTableColumns(table)).map(([key, column]) => ({
      key,
      name: column.name,
      type: column.getSQLType(),
      nullable: !column.notNull,
      primary:
        column.primary ||
        config.primaryKeys.some((pk) => pk.columns.includes(column)),
    })),
  };
});

export function createContextRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  return {
    async browse(
      input: ReturnType<typeof contextBrowseQuerySchema.parse>,
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
    ) {
      return access(identity, assertCurrent, async (tx) => {
        const search = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
        const cursor = input.cursor;
        const entityFilter = input.entity
          ? and(
              eq(contextEntities.entityType, input.entity.type),
              eq(contextEntities.entityId, input.entity.id),
            )
          : undefined;
        const rows =
          input.table === "household_subjects"
            ? await tx
                .select({
                  ...getTableColumns(householdSubjects),
                  // Retain database microseconds; JS Date truncation would skip tied rows.
                  cursorTime: sql<string>`to_char(${householdSubjects.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
                })
                .from(householdSubjects)
                .where(
                  and(
                    ilike(householdSubjects.name, search),
                    cursor?.table === "household_subjects"
                      ? sql`(${householdSubjects.createdAt}, ${householdSubjects.id}) < (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
                      : undefined,
                  ),
                )
                .orderBy(
                  desc(householdSubjects.createdAt),
                  desc(householdSubjects.id),
                )
                .limit(pageSize + 1)
            : input.table === "context_records"
              ? await tx
                  .select({
                    ...getTableColumns(contextRecords),
                    cursorTime: sql<string>`to_char(${contextRecords.occurredAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
                  })
                  .from(contextRecords)
                  .where(
                    and(
                      or(
                        ilike(contextRecords.summary, search),
                        ilike(contextRecords.topic, search),
                      ),
                      input.context_id
                        ? eq(contextRecords.id, input.context_id)
                        : undefined,
                      input.entity
                        ? inArray(
                            contextRecords.id,
                            tx
                              .select({ id: contextEntities.contextId })
                              .from(contextEntities)
                              .where(entityFilter),
                          )
                        : undefined,
                      cursor?.table === "context_records"
                        ? sql`(${contextRecords.occurredAt}, ${contextRecords.id}) < (${cursor.occurred_at}::timestamptz, ${cursor.id}::uuid)`
                        : undefined,
                    ),
                  )
                  .orderBy(
                    desc(contextRecords.occurredAt),
                    desc(contextRecords.id),
                  )
                  .limit(pageSize + 1)
              : await tx
                  .select()
                  .from(contextEntities)
                  .where(
                    and(
                      ilike(contextEntities.entityId, search),
                      input.context_id
                        ? eq(contextEntities.contextId, input.context_id)
                        : undefined,
                      entityFilter,
                      cursor?.table === "context_entities"
                        ? sql`(${contextEntities.contextId}, ${contextEntities.entityType}, ${contextEntities.entityId}, ${contextEntities.role}) > (${cursor.context_id}::uuid, ${cursor.entity_type}::context_entity_type, ${cursor.entity_id}::text, ${cursor.role}::context_entity_role)`
                        : undefined,
                    ),
                  )
                  .orderBy(
                    contextEntities.contextId,
                    contextEntities.entityType,
                    contextEntities.entityId,
                    contextEntities.role,
                  )
                  .limit(pageSize + 1);
        const last = rows.length > pageSize ? rows[pageSize - 1] : undefined;
        const nextCursor = !last
          ? null
          : "occurredAt" in last
            ? {
                table: "context_records",
                id: last.id,
                occurred_at: last.cursorTime,
              }
            : "createdAt" in last
              ? {
                  table: "household_subjects",
                  id: last.id,
                  created_at: last.cursorTime,
                }
              : {
                  table: "context_entities",
                  context_id: last.contextId,
                  entity_type: last.entityType,
                  entity_id: last.entityId,
                  role: last.role,
                };
        // PostgreSQL maintains these estimates without scanning history on each page.
        const statistics = await tx.execute(
          sql`select relname, n_live_tup from pg_stat_user_tables where schemaname = current_schema() and relname in ('context_records', 'context_entities')`,
        );
        const counts = new Map(
          statistics.map((row) => [
            String(row.relname),
            Math.max(0, Number(row.n_live_tup)),
          ]),
        );
        const subjects = await tx.$count(householdSubjects);
        const response = contextBrowseResponseSchema.parse({
          scope_epoch: input.scope_epoch,
          table: input.table,
          page_size: pageSize,
          has_more: last !== undefined,
          next_cursor:
            nextCursor === null ? null : contextCursorSchema.parse(nextCursor),
          tables: metadata.map((table) => ({
            ...table,
            count:
              table.name === "household_subjects"
                ? subjects
                : (counts.get(table.name) ?? 0),
            count_is_estimate: table.name !== "household_subjects",
          })),
          rows: rows.slice(0, pageSize).map((row) =>
            Object.fromEntries(
              Object.entries(row)
                .filter(([key]) => key !== "cursorTime")
                .map(([key, value]) => [
                  key,
                  value instanceof Date ? value.toISOString() : value,
                ]),
            ),
          ),
        });
        if (jsonBytes(response) > 2 * 1024 * 1024)
          throw new HouseholdError("capacity_exceeded");
        return response;
      });
    },
  };
}
