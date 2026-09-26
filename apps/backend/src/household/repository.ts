import { isDeepStrictEqual } from "node:util";
import { eq, and } from "drizzle-orm";
import {
  directorySchema,
  deviceSchema,
  initialSpecification,
} from "@home-agent/api/household";
import { z } from "zod";
import type { Database } from "../db";
import { householdDirectories } from "../db/schema";
import { HouseholdError } from "./errors";
import { householdLimits, jsonBytes } from "./config";
import {
  createConfirmedWriter,
  createLockedTransactions,
  StorageOutcomeUnknownError,
} from "../db/transaction-outcome";

const storedDirectorySchema = directorySchema.extend({
  device: z.record(
    z.string(),
    deviceSchema.omit({
      category: true,
      capability_tags: true,
      spec_id: true,
      spec_status: true,
      spec_error: true,
      availability: true,
      read_enabled_properties: true,
      alias: true,
    }),
  ),
});
function directoryLockKey(accountId: string, homeId: string) {
  return JSON.stringify(["household_directory", accountId, homeId]);
}
function directoryIdentity(accountId: string, homeId: string) {
  return and(
    eq(householdDirectories.accountId, accountId),
    eq(householdDirectories.homeId, homeId),
  );
}
/** Stores the current complete directory; removed entries are not a history store. */
export function createHouseholdRepository(db: Database) {
  const transaction = createLockedTransactions(
    db,
    householdLimits.transactionMs,
  );
  const write = createConfirmedWriter(transaction);
  return {
    async read(accountId: string, homeId: string) {
      const [row] = await transaction(
        directoryLockKey(accountId, homeId),
        (tx) =>
          tx
            .select()
            .from(householdDirectories)
            .where(directoryIdentity(accountId, homeId)),
      ).catch(() => {
        throw new HouseholdError("home_storage");
      });
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
              ...initialSpecification,
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
      if (jsonBytes(data) > householdLimits.directoryBytes)
        throw new HouseholdError("capacity_exceeded");
      try {
        const savedAt = await write(
          directoryLockKey(accountId, homeId),
          async (tx, beforeWrite) => {
            assertCurrent();
            const [row] = await tx
              .select()
              .from(householdDirectories)
              .where(directoryIdentity(accountId, homeId));
            assertCurrent();
            if (row && isDeepStrictEqual(row.directory, data))
              return row.updatedAt.toISOString();
            const updatedAt = new Date();
            beforeWrite();
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
          },
          async (tx) => {
            const [row] = await tx
              .select()
              .from(householdDirectories)
              .where(directoryIdentity(accountId, homeId));
            return row && isDeepStrictEqual(row.directory, data)
              ? { committed: true, value: row.updatedAt.toISOString() }
              : { committed: false };
          },
        );
        assertCurrent();
        return savedAt;
      } catch (error) {
        if (
          error instanceof HouseholdError ||
          error instanceof StorageOutcomeUnknownError
        )
          throw error;
        assertCurrent();
        throw new HouseholdError("home_storage");
      }
    },
  };
}
export type HouseholdRepository = ReturnType<typeof createHouseholdRepository>;
