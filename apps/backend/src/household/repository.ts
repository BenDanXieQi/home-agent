import { isDeepStrictEqual } from "node:util";
import { eq, sql, and } from "drizzle-orm";
import { directorySchema, deviceSchema } from "@home-agent/api/household";
import { z } from "zod";
import type { Database } from "../db";
import { householdDirectories } from "../db/schema";
import { MijiaError } from "../mijia/errors";
import { householdLimits, jsonBytes } from "./config";

const storedDirectorySchema = directorySchema.extend({
  device: z.record(
    z.string(),
    deviceSchema.omit({
      category: true,
      capability_tags: true,
      spec_id: true,
      availability: true,
      read_enabled_properties: true,
      alias: true,
    }),
  ),
});
/** Public directory only; authorization material never enters this repository. */
export function createHouseholdRepository(db: Database) {
  return {
    async read(accountId: string, homeId: string) {
      const [row] = await db
        .select()
        .from(householdDirectories)
        .where(
          and(
            eq(householdDirectories.accountId, accountId),
            eq(householdDirectories.homeId, homeId),
          ),
        );
      if (!row) return undefined;
      const stored = storedDirectorySchema.parse(row.directory);
      const data = {
        ...stored,
        device: Object.fromEntries(
          Object.entries(stored.device).map(([key, device]) => [
            key,
            deviceSchema.parse({
              ...device,
              category: null,
              capability_tags: [],
              spec_id: null,
              availability: "unknown",
              read_enabled_properties: [],
              alias: null,
            }),
          ]),
        ),
      };
      return {
        directory: Object.fromEntries(
          Object.entries(data).map(([kind, records]) => [
            kind,
            Object.fromEntries(
              Object.entries(records).filter(([, value]) => !value.archived),
            ),
          ]),
        ),
        savedAt: row.updatedAt.toISOString(),
      };
    },
    async save(
      accountId: string,
      homeId: string,
      directory: z.infer<typeof directorySchema>,
      assertCurrent: () => void,
    ) {
      const data = storedDirectorySchema.parse(directory);
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('statement_timeout', ${String(householdLimits.transactionMs)}, true), set_config('lock_timeout', ${String(householdLimits.transactionMs)}, true), set_config('transaction_timeout', ${String(householdLimits.transactionMs)}, true)`,
          );
          assertCurrent();
          const [row] = await tx
            .select()
            .from(householdDirectories)
            .where(
              and(
                eq(householdDirectories.accountId, accountId),
                eq(householdDirectories.homeId, homeId),
              ),
            )
            .for("update");
          const previous = row
            ? storedDirectorySchema.parse(row.directory)
            : { home: {}, room: {}, device: {} };
          for (const kind of ["home", "room", "device"] as const) {
            const target: Record<string, unknown> = data[kind];
            for (const [key, value] of Object.entries(previous[kind])) {
              if (!(key in target)) target[key] = { ...value, archived: true };
            }
          }
          if (jsonBytes(data) > householdLimits.directoryBytes)
            throw new MijiaError("capacity_exceeded");
          assertCurrent();
          const updatedAt = new Date();
          await tx
            .insert(householdDirectories)
            .values({ accountId, homeId, directory: data, updatedAt })
            .onConflictDoUpdate({
              target: [
                householdDirectories.accountId,
                householdDirectories.homeId,
              ],
              set: { directory: data, updatedAt },
            });
          assertCurrent();
          return updatedAt.toISOString();
        });
      } catch (error) {
        // A lost COMMIT response is not proof of rollback. Read the durable result
        // before allowing the discovery owner to retry this candidate.
        const [row] = await db
          .select()
          .from(householdDirectories)
          .where(
            and(
              eq(householdDirectories.accountId, accountId),
              eq(householdDirectories.homeId, homeId),
            ),
          )
          .catch(() => []);
        assertCurrent();
        if (row && isDeepStrictEqual(row.directory, data))
          return row.updatedAt.toISOString();
        throw error;
      }
    },
  };
}
export type HouseholdRepository = ReturnType<typeof createHouseholdRepository>;
