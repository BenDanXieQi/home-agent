import { sql } from "drizzle-orm";
import type { Transaction } from "../../db/transaction-outcome";

export async function enqueueAutomationJob(
  tx: Transaction,
  task: "automation_review_execute" | "automation_decision",
  payload: Record<string, string | number>,
  key: string,
) {
  await tx.execute(
    sql`select graphile_worker.add_job(${task}, payload := ${JSON.stringify(payload)}::json, max_attempts := 1::smallint, job_key := ${key})`,
  );
}
