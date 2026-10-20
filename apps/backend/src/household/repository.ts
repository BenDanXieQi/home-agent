import { isDeepStrictEqual } from "node:util";
import { eq, sql } from "drizzle-orm";
import {
  directorySchema,
  deviceSchema,
  initialSpecification,
} from "@home-agent/api/household";
import { z } from "zod";
import type { Database } from "../db";
import { householdDirectories, mijiaHomeSelections } from "../db/schema";
import { HouseholdError } from "./errors";
import { householdLimits, jsonBytes } from "./config";
import {
  createConfirmedWriter,
  createLockedTransactions,
  lockTransaction,
  StorageOutcomeUnknownError,
  type Transaction,
} from "../db/transaction-outcome";

import {
  householdBindingLock,
  assertHouseholdBinding,
} from "./binding-repository";

const storedDirectorySchema = directorySchema.extend({
  device: z.record(
    z.string(),
    deviceSchema.omit({
      category: true,
      capability_tags: true,
      spec_id: true,
      spec_status: true,
      spec_error: true,
      read_enabled_properties: true,
      alias: true,
    }),
  ),
});
const directoryLockKey = "household_directory";
export function createHouseholdRepository(db: Database) {
  const bindingTransaction = createLockedTransactions(
    db,
    householdLimits.transactionMs,
    "shared",
  );
  const transaction = <T>(key: string, run: (tx: Transaction) => Promise<T>) =>
    bindingTransaction(householdBindingLock, async (tx) => {
      await lockTransaction(tx, key, "exclusive");
      return run(tx);
    });
  async function readStored(
    tx: Parameters<Parameters<typeof transaction>[1]>[0],
  ) {
    const [row] = await tx
      .select()
      .from(householdDirectories)
      .where(eq(householdDirectories.id, 1));
    return row
      ? {
          directory: storedDirectorySchema.parse(row.directory),
          savedAt: row.updatedAt.toISOString(),
        }
      : undefined;
  }
  const write = createConfirmedWriter(transaction);
  return {
    async read() {
      const row = await transaction(directoryLockKey, (tx) =>
        readStored(tx),
      ).catch(() => {
        throw new HouseholdError("home_storage");
      });
      if (!row) return undefined;
      const stored = row.directory;
      const data = {
        ...stored,
        device: Object.fromEntries(
          Object.entries(stored.device).map(([key, device]) => [
            key,
            {
              ...device,
              category: null,
              capability_tags: [],
              ...initialSpecification,
              read_enabled_properties: [],
              alias: null,
            },
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
        savedAt: row.savedAt,
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
      assertCurrent();
      try {
        const savedAt = await write(
          directoryLockKey,
          async (tx, beforeWrite) => {
            assertCurrent();
            const bindings = await tx
              .select()
              .from(mijiaHomeSelections)
              .limit(2);
            assertHouseholdBinding({ accountId, homeId }, bindings);
            const row = await readStored(tx);
            assertCurrent();
            if (row && isDeepStrictEqual(row.directory, data))
              return row.savedAt;
            const updatedAt = new Date();
            beforeWrite();
            if (!row) {
              await tx.insert(householdDirectories).values({
                id: 1,
                directory: data,
                updatedAt,
              });
            } else {
              const previous = row.directory;
              let expression = sql`${householdDirectories.directory}`;
              for (const entity of ["home", "room", "device"] as const) {
                const removed = Object.keys(previous[entity]).filter(
                  (id) => !Object.hasOwn(data[entity], id),
                );
                const upserts = Object.fromEntries(
                  Object.entries(data[entity]).filter(
                    ([id, value]) =>
                      !isDeepStrictEqual(previous[entity][id], value),
                  ),
                );
                if (!removed.length && !Object.keys(upserts).length) continue;
                const records = sql`((${householdDirectories.directory} -> ${entity})
                  - ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(removed)}::jsonb)))
                  || ${JSON.stringify(upserts)}::jsonb`;
                expression = sql`jsonb_set(${expression}, ARRAY[${entity}], ${records})`;
              }
              await tx
                .update(householdDirectories)
                .set({ directory: expression, updatedAt })
                .where(eq(householdDirectories.id, 1));
            }
            assertCurrent();
            return updatedAt.toISOString();
          },
          async (tx) => {
            const row = await readStored(tx);
            return row && isDeepStrictEqual(row.directory, data)
              ? { committed: true, value: row.savedAt }
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
