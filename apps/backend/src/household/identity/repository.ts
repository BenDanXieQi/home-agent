import { eq, sql } from "drizzle-orm";
import type { Transaction } from "../../db/transaction-outcome";
import {
  identityMembers,
  identityReferenceState,
  identitySamples,
} from "../../db/schema";

// Shared with member writes; caller already holds the household binding lock.
export async function lockIdentityMembers(tx: Transaction) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('household_members', 0))`,
  );
}

export async function readReferenceVersion(tx: Transaction) {
  await tx.insert(identityReferenceState).values({}).onConflictDoNothing();
  const [state] = await tx.select().from(identityReferenceState);
  return state!;
}

export async function changeReferenceVersion(
  tx: Transaction,
  content: boolean,
) {
  await readReferenceVersion(tx);
  await tx.update(identityReferenceState).set({
    ...(content ? { contentVersion: crypto.randomUUID() } : {}),
    eligibilityVersion: crypto.randomUUID(),
  });
}

/** Called in the same transaction as deleting a member or changing household. */
export async function revokeMemberReferences(
  tx: Transaction,
  invalidateReferences: () => void,
  memberId?: string,
) {
  const samples = await tx
    .select({ id: identitySamples.id })
    .from(identitySamples)
    .where(memberId ? eq(identitySamples.memberId, memberId) : undefined)
    .limit(1);
  const removed = await tx
    .delete(identityMembers)
    .where(memberId ? eq(identityMembers.memberId, memberId) : undefined)
    .returning({ memberId: identityMembers.memberId });
  // A household replacement must invalidate even an empty reference snapshot.
  const changed = !memberId || removed.length > 0;
  if (changed) {
    invalidateReferences();
    await changeReferenceVersion(tx, !memberId || samples.length > 0);
  }
  return changed;
}
