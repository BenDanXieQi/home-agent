import { and, eq, gt, sql } from "drizzle-orm";
import { automationModelAdmissions } from "../../db/schema";
import type { Transaction } from "../../db/transaction-outcome";

/** Shared paid-request budget for automation reviews and action decisions. */
export async function reserveAutomationModelBudget(
  tx: Transaction,
  requestId: string,
  identity: { accountId: string; homeId: string },
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["automation-model-budget", identity.accountId, identity.homeId])},0))`,
  );
  const [existing] = await tx
    .select()
    .from(automationModelAdmissions)
    .where(eq(automationModelAdmissions.id, requestId));
  if (existing)
    return (
      existing.accountId === identity.accountId &&
      existing.homeId === identity.homeId
    );
  const count = await tx.$count(
    automationModelAdmissions,
    and(
      eq(automationModelAdmissions.accountId, identity.accountId),
      eq(automationModelAdmissions.homeId, identity.homeId),
      gt(automationModelAdmissions.createdAt, new Date(Date.now() - 3600_000)),
    ),
  );
  if (count >= 20) return false;
  await tx
    .insert(automationModelAdmissions)
    .values({ id: requestId, ...identity });
  await tx.execute(
    sql`delete from automation_model_admissions where created_at < now() - interval '2 days'`,
  );
  return true;
}
