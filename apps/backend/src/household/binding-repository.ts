import type { Database } from "../db";
import { mijiaHomeSelections } from "../db/schema";
import {
  createLockedTransactions,
  type Transaction,
} from "../db/transaction-outcome";
import type { DirectoryCandidate } from "./directory";
import { householdLimits } from "./config";
import { HouseholdError } from "./errors";

export const householdBindingLock = "household_binding";

/** Hold shared binding access while operating on the current household's data. */
export function createHouseholdBindingAccess(db: Database) {
  const transaction = createLockedTransactions(
    db,
    householdLimits.transactionMs,
    "shared",
  );
  return <T>(
    identity: Pick<DirectoryCandidate, "accountId" | "homeId">,
    assertCurrent: () => void,
    run: (tx: Transaction) => Promise<T>,
  ) =>
    transaction(householdBindingLock, async (tx) => {
      assertCurrent();
      const rows = await tx.select().from(mijiaHomeSelections).limit(2);
      const binding = rows[0];
      if (
        rows.length !== 1 ||
        binding?.accountKey !== identity.accountId ||
        binding.homeId !== identity.homeId
      )
        throw new HouseholdError("stale_session");
      const result = await run(tx);
      assertCurrent();
      return result;
    });
}
