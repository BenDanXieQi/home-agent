import { agentContextPolicy } from "@home-agent/api/agent-context";
import { recordPruneBatchSize } from "../records/retention";
import { provenanceQueryHash } from "../records/query";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  commandRecordSchema,
  provenancePolicy,
  commandQueryResponseSchema,
  type commandQuerySchema,
} from "@home-agent/api/action-provenance";
import type { Database } from "../../db";
import { deviceCommands } from "../../db/schema";
import {
  createHouseholdBindingAccess,
  createHouseholdBindingRead,
} from "../binding-repository";
import type { accessHousehold } from "../access";
import { jsonBytes } from "../config";
import { HouseholdError } from "../errors";

type Scope = Pick<
  ReturnType<typeof accessHousehold>,
  "identity" | "assertCurrent"
>;
export function createCommandRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  const read = createHouseholdBindingRead(db);
  const table = deviceCommands;
  const listeners = new Set<() => void>();
  return {
    async recordCommand(
      scope: Scope,
      input: ReturnType<typeof commandRecordSchema.parse>,
    ) {
      const data = commandRecordSchema.parse(input);
      if (jsonBytes(data) > provenancePolicy.recordBytes)
        throw new HouseholdError("capacity_exceeded");
      await access(scope.identity, scope.assertCurrent, async (tx) => {
        await tx
          .insert(table)
          .values({
            id: data.id,
            deviceId: data.target.device_id,
            calledAt: new Date(data.called_at),
            expiresAt: new Date(data.expires_at),
            data,
          })
          .onConflictDoNothing();
      });
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.error("Command subscriber failed", error);
        }
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async readRecentCommands(scope: Scope, asOf: Date) {
      return access(scope.identity, scope.assertCurrent, async (tx) => {
        const rows = await tx
          .select({ data: table.data })
          .from(table)
          .where(
            and(
              sql`${table.expiresAt} > ${asOf.toISOString()}::timestamptz`,
              sql`${table.calledAt} > ${new Date(asOf.getTime() - agentContextPolicy.recentOperationMs).toISOString()}::timestamptz`,
              sql`${table.calledAt} <= ${asOf.toISOString()}::timestamptz`,
            ),
          )
          .orderBy(desc(table.calledAt), desc(table.id))
          .limit(agentContextPolicy.recentOperationLimit + 1);
        return rows.map((row) => commandRecordSchema.parse(row.data));
      });
    },
    async queryCommands(
      scope: Scope,
      input: ReturnType<typeof commandQuerySchema.parse>,
    ) {
      const queryHash = provenanceQueryHash("commands", scope, input);
      return read(scope.identity, scope.assertCurrent, async (tx) => {
        const query = tx`
          select data from device_commands
          where expires_at > now()
            and called_at >= ${input.start}::timestamptz
            and called_at < ${input.end}::timestamptz
            ${input.device_id ? tx`and device_id = ${input.device_id}` : tx``}
            ${input.source ? tx`and data->'source'->>'executor' = ${input.source}` : tx``}
            ${input.cursor ? tx`and (called_at, id) > (${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)` : tx``}
          order by called_at, id
          limit ${input.limit + 1}
        `;
        const records: ReturnType<typeof commandRecordSchema.parse>[] = [];
        let bytes = 512;
        let more = false;
        for await (const rows of query.cursor(16)) {
          scope.assertCurrent();
          for (const row of rows) {
            if (records.length === input.limit) {
              more = true;
              break;
            }
            const record = commandRecordSchema.parse(row.data);
            const size = jsonBytes(record) + 1;
            if (bytes + size > provenancePolicy.responseBytes) {
              if (!records.length)
                throw new HouseholdError("capacity_exceeded");
              more = true;
              break;
            }
            records.push(record);
            bytes += size;
          }
          if (more) break;
        }
        const last = records.at(-1);
        return commandQueryResponseSchema.parse({
          records,
          next_cursor:
            last && more
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
          .where(and(sql`${table.expiresAt} > now()`, eq(table.id, id)))
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
