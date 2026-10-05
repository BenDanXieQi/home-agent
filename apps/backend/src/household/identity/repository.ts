import { sql } from "drizzle-orm";
import type { Transaction } from "../../db/transaction-outcome";

// Shared with member writes; caller already holds the household binding lock.
export async function lockIdentityMembers(tx: Transaction) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('household_members', 0))`,
  );
}
