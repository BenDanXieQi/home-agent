import { eq } from "drizzle-orm";
import type { Database } from "../../db";
import { mijiaHomeSelections } from "../../db/schema";
import { householdLimits } from "../../household/config";
import { MijiaError } from "../errors";
import {
  createConfirmedWriter,
  createLockedTransactions,
  StorageOutcomeUnknownError,
} from "../../db/transaction-outcome";

const bindingLockKey = "household_binding";

export function createHomeSelectionStore(db: Database) {
  const transaction = createLockedTransactions(
    db,
    householdLimits.transactionMs,
  );
  const write = createConfirmedWriter(transaction);
  return {
    async read(accountKey: string) {
      try {
        const rows = await transaction(bindingLockKey, (tx) =>
          tx.select().from(mijiaHomeSelections).limit(2),
        );
        const row = rows[0];
        if (rows.length > 1 || (row && row.accountKey !== accountKey))
          throw new MijiaError("binding_conflict");
        return row ? { homeId: row.homeId } : undefined;
      } catch (error) {
        if (error instanceof MijiaError) throw error;
        throw new MijiaError("home_storage");
      }
    },
    async write(accountKey: string, homeId: string, assertCurrent: () => void) {
      try {
        await write(
          bindingLockKey,
          async (tx, beforeWrite) => {
            assertCurrent();
            const rows = await tx.select().from(mijiaHomeSelections).limit(2);
            assertCurrent();
            const row = rows[0];
            if (
              rows.length > 1 ||
              (row && (row.accountKey !== accountKey || row.homeId !== homeId))
            )
              throw new MijiaError("binding_conflict");
            if (row) return true;
            const data = { accountKey, homeId, updatedAt: new Date() };
            beforeWrite();
            await tx
              .insert(mijiaHomeSelections)
              .values(data)
              .onConflictDoUpdate({
                target: mijiaHomeSelections.accountKey,
                set: data,
              });
            assertCurrent();
            return true;
          },
          async (tx) => {
            const [row] = await tx
              .select()
              .from(mijiaHomeSelections)
              .where(eq(mijiaHomeSelections.accountKey, accountKey));
            return row && row.homeId === homeId
              ? { committed: true, value: true }
              : { committed: false };
          },
        );
        assertCurrent();
      } catch (error) {
        if (
          error instanceof MijiaError ||
          error instanceof StorageOutcomeUnknownError
        )
          throw error;
        assertCurrent();
        throw new MijiaError("home_storage");
      }
    },
  };
}
export type HomeSelectionStore = ReturnType<typeof createHomeSelectionStore>;
