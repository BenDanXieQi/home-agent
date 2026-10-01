import {
  and,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  or,
} from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  contextBrowseResponseSchema,
  contextTableSchema,
  type contextBrowseQuerySchema,
} from "@home-agent/api/household-context";
import type { Database } from "../db";
import {
  contextEntities,
  contextRecords,
  householdSubjects,
  mijiaHomeSelections,
} from "../db/schema";
import { createLockedTransactions } from "../db/transaction-outcome";
import { HouseholdError } from "../household/errors";
import { householdLimits, jsonBytes } from "../household/config";

const tables = {
  household_subjects: householdSubjects,
  context_records: contextRecords,
  context_entities: contextEntities,
};
const pageSize = 25;

export function createContextRepository(db: Database) {
  const transaction = createLockedTransactions(
    db,
    householdLimits.transactionMs,
  );
  return {
    async browse(
      input: ReturnType<typeof contextBrowseQuerySchema.parse>,
      identity: { accountId: string; homeId: string },
      assertCurrent: () => void,
    ) {
      return transaction("household_binding", async (tx) => {
        assertCurrent();
        const [binding] = await tx.select().from(mijiaHomeSelections).limit(1);
        if (
          binding?.accountKey !== identity.accountId ||
          binding.homeId !== identity.homeId
        )
          throw new HouseholdError("stale_session");
        const search = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
        const entityFilter = input.entity
          ? and(
              eq(contextEntities.entityType, input.entity.type),
              eq(contextEntities.entityId, input.entity.id),
            )
          : undefined;
        const rows =
          input.table === "household_subjects"
            ? await tx
                .select()
                .from(householdSubjects)
                .where(ilike(householdSubjects.name, search))
                .orderBy(
                  desc(householdSubjects.createdAt),
                  desc(householdSubjects.id),
                )
                .limit(pageSize + 1)
                .offset(input.page * pageSize)
            : input.table === "context_records"
              ? await tx
                  .select()
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
                    ),
                  )
                  .orderBy(
                    desc(contextRecords.occurredAt),
                    desc(contextRecords.id),
                  )
                  .limit(pageSize + 1)
                  .offset(input.page * pageSize)
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
                    ),
                  )
                  .orderBy(
                    contextEntities.contextId,
                    contextEntities.entityType,
                    contextEntities.entityId,
                    contextEntities.role,
                  )
                  .limit(pageSize + 1)
                  .offset(input.page * pageSize);
        const metadata = [];
        for (const name of contextTableSchema.options) {
          const table = tables[name];
          const config = getTableConfig(table);
          metadata.push({
            name,
            count: await tx.$count(table),
            columns: Object.entries(getTableColumns(table)).map(
              ([key, column]) => ({
                key,
                name: column.name,
                type: column.getSQLType(),
                nullable: !column.notNull,
                primary:
                  column.primary ||
                  config.primaryKeys.some((pk) => pk.columns.includes(column)),
              }),
            ),
          });
        }
        const response = contextBrowseResponseSchema.parse({
          scope_epoch: input.scope_epoch,
          table: input.table,
          page: input.page,
          page_size: pageSize,
          has_more: rows.length > pageSize,
          tables: metadata,
          rows: rows
            .slice(0, pageSize)
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  value instanceof Date ? value.toISOString() : value,
                ]),
              ),
            ),
        });
        if (jsonBytes(response) > 2 * 1024 * 1024)
          throw new HouseholdError("capacity_exceeded");
        assertCurrent();
        return response;
      });
    },
  };
}
