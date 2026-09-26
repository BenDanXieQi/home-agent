import { eq, sql } from "drizzle-orm";
import type { Database } from "../../db";
import { mijiaHomeSelections } from "../../db/schema";
import { householdLimits } from "../../household/config";
import { MijiaError } from "../errors";

export function createHomeSelectionStore(db: Database) {
  return {
    async read(accountKey: string) {
      try {
        const [row] = await db
          .select()
          .from(mijiaHomeSelections)
          .where(eq(mijiaHomeSelections.accountKey, accountKey));
        return row ? { homeId: row.homeId } : undefined;
      } catch {
        throw new MijiaError("home_storage");
      }
    },
    async write(
      accountKey: string,
      homeId: string | null,
      assertCurrent: () => void,
    ) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('statement_timeout', ${String(householdLimits.transactionMs)}, true), set_config('lock_timeout', ${String(householdLimits.transactionMs)}, true), set_config('transaction_timeout', ${String(householdLimits.transactionMs)}, true)`,
          );
          assertCurrent();
          const data = { accountKey, homeId, updatedAt: new Date() };
          await tx.insert(mijiaHomeSelections).values(data).onConflictDoUpdate({
            target: mijiaHomeSelections.accountKey,
            set: data,
          });
          assertCurrent();
        });
      } catch (error) {
        if (error instanceof MijiaError) throw error;
        const [row] = await db
          .select()
          .from(mijiaHomeSelections)
          .where(eq(mijiaHomeSelections.accountKey, accountKey))
          .catch(() => []);
        assertCurrent();
        if (row && row.homeId === homeId) return;
        throw new MijiaError("home_storage");
      }
    },
  };
}
export type HomeSelectionStore = ReturnType<typeof createHomeSelectionStore>;
