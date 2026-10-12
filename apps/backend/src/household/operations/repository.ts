import { recordPruneBatchSize } from "../records/retention";
import { provenanceQueryHash } from "../records/query";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  commandRecordSchema,
  commandSummarySchema,
  provenancePolicy,
  commandQueryResponseSchema,
  type provenanceQuerySchema,
} from "@home-agent/api/action-provenance";
import type { Database } from "../../db";
import { deviceCommands } from "../../db/schema";
import { createHouseholdBindingAccess } from "../binding-repository";
import type { accessHousehold } from "../access";
import { jsonBytes } from "../config";
import { HouseholdError } from "../errors";

type Scope = Pick<
  ReturnType<typeof accessHousehold>,
  "identity" | "assertCurrent"
>;
export function createCommandRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  const table = deviceCommands;
  const ownership = (scope: Scope) =>
    and(
      eq(table.accountId, scope.identity.accountId),
      eq(table.homeId, scope.identity.homeId),
      sql`${table.expiresAt} > now()`,
    );
  return {
    async recordCommand(input: ReturnType<typeof commandRecordSchema.parse>) {
      const data = commandRecordSchema.parse(input);
      if (jsonBytes(data) > provenancePolicy.recordBytes)
        throw new HouseholdError("capacity_exceeded");
      // Binding ownership remains necessary after dispatch; epoch changes alone do not erase the snapshot.
      await access(
        { accountId: data.account_id, homeId: data.home_id },
        () => {},
        async (tx) => {
          await tx
            .insert(table)
            .values({
              id: data.id,
              accountId: data.account_id,
              homeId: data.home_id,
              deviceId: data.target.device_id,
              calledAt: new Date(data.called_at),
              expiresAt: new Date(data.expires_at),
              data,
            })
            .onConflictDoNothing();
        },
      );
    },
    async queryCommands(
      scope: Scope,
      input: ReturnType<typeof provenanceQuerySchema.parse>,
    ) {
      const queryHash = provenanceQueryHash("commands", scope, input);
      return access(scope.identity, scope.assertCurrent, async (tx) => {
        const rows = await tx
          .select({
            data: sql<unknown>`(${table.data} - 'response' - 'output' - 'message' - 'error') || jsonb_build_object('target', (${table.data}->'target') - 'value' - 'inputs')`,
          })
          .from(table)
          .where(
            and(
              ownership(scope),
              sql`${table.calledAt} >= ${input.start}::timestamptz`,
              sql`${table.calledAt} < ${input.end}::timestamptz`,
              input.device_id ? eq(table.deviceId, input.device_id) : undefined,
              input.source
                ? sql`${table.data}->'source'->>'entrypoint' = ${input.source}`
                : undefined,
              input.cursor
                ? sql`(${table.calledAt}, ${table.id}) > (${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)`
                : undefined,
            ),
          )
          .orderBy(table.calledAt, table.id)
          .limit(input.limit + 1);
        const records: ReturnType<typeof commandSummarySchema.parse>[] = [];
        let bytes = 512;
        for (const row of rows.slice(0, input.limit)) {
          const record = commandSummarySchema.parse(row.data);
          const size = jsonBytes(record) + 1;
          if (bytes + size > provenancePolicy.responseBytes) break;
          records.push(record);
          bytes += size;
        }
        if (rows.length && !records.length)
          throw new HouseholdError("capacity_exceeded");
        const last = records.at(-1);
        return commandQueryResponseSchema.parse({
          records,
          next_cursor:
            last && rows.length > records.length
              ? { at: last.called_at, id: last.id, query_hash: queryHash }
              : null,
          complete_audit: false,
        });
      });
    },
    async readCommand(scope: Scope, id: string) {
      return access(scope.identity, scope.assertCurrent, async (tx) => {
        const [row] = await tx
          .select()
          .from(table)
          .where(and(ownership(scope), eq(table.id, id)))
          .limit(1);
        return row ? commandRecordSchema.parse(row.data) : null;
      });
    },
    async pruneRecords() {
      return db.transaction(async (tx) => {
        const expired = await tx
          .select({ id: table.id })
          .from(table)
          .where(sql`${table.expiresAt} <= now()`)
          .orderBy(table.expiresAt, table.id)
          .limit(recordPruneBatchSize)
          .for("update", { skipLocked: true });
        if (expired.length)
          await tx.delete(table).where(
            inArray(
              table.id,
              expired.map((row) => row.id),
            ),
          );
        return expired.length;
      });
    },
  };
}
