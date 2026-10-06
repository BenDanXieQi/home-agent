import { enqueueAutomationJob } from "./jobs";
import { syncAutomationReviews } from "./reviews/repository";
import type { createAutomationExecution } from "./execution";
import type { advanceAutomation } from "./evaluation";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { AppError } from "@home-agent/api/errors";
import {
  automationRunSchema,
  type automationSaveRequestSchema,
} from "@home-agent/api/automations";
import { z } from "zod";
import type { Database } from "../../db";
import type { Transaction } from "../../db/transaction-outcome";
import {
  automations,
  automationRuns,
  automationActions,
  automationDecisions,
} from "../../db/schema";
import { createHouseholdBindingAccess } from "../binding-repository";
import type { accessHousehold } from "../access";
import type { automationInputSchema } from "./state";

type Scope = ReturnType<typeof accessHousehold>;
type StoredAutomation = typeof automations.$inferSelect;
const householdWhere = (scope: Scope) =>
  and(
    eq(automations.accountId, scope.identity.accountId),
    eq(automations.homeId, scope.identity.homeId),
  );
export async function lockAutomationRun(
  tx: Transaction,
  scope: Scope,
  runId: string,
) {
  const [row] = await tx
    .select({ id: automations.id })
    .from(automations)
    .innerJoin(automationRuns, eq(automationRuns.automationId, automations.id))
    .where(and(householdWhere(scope), eq(automationRuns.id, runId)))
    .for("update", { of: automations });
  return row;
}
async function find(tx: Transaction, scope: Scope, id: string) {
  const [row] = await tx
    .select()
    .from(automations)
    .where(and(householdWhere(scope), eq(automations.id, id)))
    .for("update");
  return row;
}
async function cancelPending(
  tx: Transaction,
  id: string,
  reason = "规则已修改、停用或删除",
) {
  const runs = await tx
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(eq(automationRuns.automationId, id));
  if (runs.length)
    await tx
      .update(automationDecisions)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          inArray(
            automationDecisions.id,
            runs.map((row) => row.id),
          ),
          inArray(automationDecisions.status, ["pending", "dispatching"]),
        ),
      );
  await tx
    .update(automationRuns)
    .set({ status: "cancelled", reason })
    .where(
      and(
        eq(automationRuns.automationId, id),
        inArray(automationRuns.status, ["pending", "running"]),
      ),
    );
}

export function createAutomationRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  const transaction = <T>(scope: Scope, run: (tx: Transaction) => Promise<T>) =>
    access(scope.identity, scope.assertCurrent, run);
  return {
    transaction,
    list(scope: Scope) {
      return transaction(scope, (tx) =>
        tx
          .select()
          .from(automations)
          .where(householdWhere(scope))
          .orderBy(desc(automations.updatedAt))
          .limit(101),
      );
    },
    get(scope: Scope, id: string) {
      return transaction(scope, (tx) => find(tx, scope, id));
    },
    async discardPending(scope: Scope) {
      await transaction(scope, async (tx) => {
        const rows = await tx
          .select({ id: automations.id })
          .from(automations)
          .where(householdWhere(scope))
          .for("update");
        // A completed decision may already have dispatched devices before its
        // best-effort result log was saved. Never classify that as unsent.
        if (rows.length)
          await tx
            .update(automationRuns)
            .set({
              status: "unknown",
              reason: "运行期已结束，决策已接纳但动作结果未保存；不会自动重发",
            })
            .where(
              and(
                inArray(
                  automationRuns.automationId,
                  rows.map((row) => row.id),
                ),
                inArray(automationRuns.status, ["pending", "running"]),
                sql`exists (select 1 from ${automationDecisions} where ${automationDecisions.id} = ${automationRuns.id} and ${automationDecisions.status} = 'completed')`,
              ),
            );
        for (const row of rows)
          await cancelPending(tx, row.id, "运行期已结束，未完成的执行不再补跑");
      });
    },
    async save(
      scope: Scope,
      input: z.infer<typeof automationSaveRequestSchema>,
    ) {
      return transaction(scope, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('automation-definitions', 0))`,
        );
        const old = await find(tx, scope, input.id);
        if (
          old &&
          old.revision === input.expected_revision + 1 &&
          old.enabled === input.enabled &&
          isDeepStrictEqual(old.definition, input.definition)
        )
          return old;
        if ((old?.revision ?? 0) !== input.expected_revision)
          throw new AppError("invalid_request", {
            params: { reason: "规则版本已变更，请刷新后重试" },
          });
        if (!old) {
          const count = await tx
            .select({ id: automations.id })
            .from(automations)
            .where(householdWhere(scope))
            .limit(100);
          if (count.length >= 100) throw new AppError("request_too_large");
        }
        const data = {
          accountId: scope.identity.accountId,
          homeId: scope.identity.homeId,
          definition: input.definition,
          enabled: input.enabled,
          revision: input.expected_revision + 1,
          updatedAt: new Date(),
        };
        const [saved] = old
          ? await tx
              .update(automations)
              .set(data)
              .where(eq(automations.id, old.id))
              .returning()
          : await tx
              .insert(automations)
              .values({ id: input.id, ...data })
              .returning();
        if (!saved) throw new AppError("persistence_unavailable");
        await syncAutomationReviews(tx, saved);
        await cancelPending(tx, input.id);
        return saved;
      });
    },
    async remove(scope: Scope, id: string, revision: number) {
      return transaction(scope, async (tx) => {
        const row = await find(tx, scope, id);
        if (!row) return;
        if (row.revision !== revision)
          throw new AppError("invalid_request", {
            params: { reason: "规则版本已变更" },
          });
        await cancelPending(tx, id);
        await tx.delete(automations).where(eq(automations.id, id));
      });
    },
    async recordDecision(
      scope: Scope,
      automation: StoredAutomation,
      input: z.infer<typeof automationInputSchema>,
      evaluation: ReturnType<typeof advanceAutomation>["evaluation"],
      timing: typeof automationRuns.$inferInsert.timing,
    ) {
      const id = crypto.randomUUID();
      const expiresAt = new Date(
        Date.parse(input.at) + automation.definition.action_ttl_seconds * 1000,
      );
      const recordingStartedAt = new Date().toISOString();
      const recorded = await transaction(scope, async (tx) => {
        const row = await find(tx, scope, automation.id);
        if (
          !row?.enabled ||
          !row.definition.decision ||
          row.revision !== automation.revision ||
          input.scope_epoch !== scope.snapshot.scope_epoch ||
          expiresAt.getTime() <= Date.now()
        )
          return false;
        await tx.insert(automationRuns).values({
          id,
          automationId: row.id,
          revision: row.revision,
          input,
          status: "pending",
          reason: null,
          evaluation,
          timing: { ...timing, recording_started_at: recordingStartedAt },
          expiresAt,
        });
        await tx.insert(automationDecisions).values({
          id,
          input: {
            request_id: id,
            automation_id: row.id,
            revision: row.revision,
            goal: row.definition.decision.goal,
            evaluated_at: input.at,
            expires_at: expiresAt.toISOString(),
            context: {
              scope_epoch: input.scope_epoch,
              sequence: input.sequence,
              facts: input.facts,
              evaluation,
            },
            allowed_actions: row.definition.actions,
          },
          status: "pending",
          timing: { queued_at: new Date().toISOString() },
        });
        await enqueueAutomationJob(
          tx,
          "automation_decision",
          { id },
          `decision:${id}`,
        );
        return true;
      });
      const committedAt = new Date().toISOString();
      if (recorded) {
        try {
          await db
            .update(automationRuns)
            .set({
              timing: sql`${automationRuns.timing} || ${JSON.stringify({ committed_at: committedAt })}::jsonb`,
            })
            .where(eq(automationRuns.id, id));
        } catch (error) {
          console.warn(
            "自动化执行登记时间未保存",
            error instanceof Error ? error.name : "unknown",
          );
        }
      }
    },
    async recordExecution(
      scope: Scope,
      execution: ReturnType<typeof createAutomationExecution>,
    ) {
      const recordingStartedAt = new Date().toISOString();
      const recorded = await transaction(scope, async (tx) => {
        // Logs do not grant execution permission. Retain real results after a
        // revision change, but never recreate a deleted rule or an old household.
        if (!(await find(tx, scope, execution.run.automationId))) return false;
        await tx
          .insert(automationRuns)
          .values({
            ...execution.run,
            timing: {
              ...execution.run.timing,
              recording_started_at: recordingStartedAt,
            },
          })
          .onConflictDoUpdate({
            target: automationRuns.id,
            set: { status: execution.run.status, reason: execution.run.reason },
          });
        if (execution.actions.length)
          await tx.insert(automationActions).values(execution.actions);
        return true;
      });
      if (recorded && !execution.definition.decision) {
        const committedAt = new Date().toISOString();
        await db
          .update(automationRuns)
          .set({
            timing: sql`${automationRuns.timing} || ${JSON.stringify({ committed_at: committedAt })}::jsonb`,
          })
          .where(eq(automationRuns.id, execution.run.id));
      }
    },
    async pruneHistory(scope: Scope) {
      await transaction(scope, async (tx) => {
        await tx.execute(sql`
          delete from automation_runs where id in (
            select id from (
              select r.id, r.expires_at, r.created_at,
                row_number() over (partition by r.automation_id order by r.created_at desc) as position
              from automation_runs r
              join automations a on a.id = r.automation_id
              where a.account_id = ${scope.identity.accountId} and a.home_id = ${scope.identity.homeId}
            ) history
            where expires_at < now()
              and (position > 1000 or created_at < now() - interval '7 days')
          )
        `);
      });
    },
    async runs(scope: Scope, automationId: string | undefined, limit: number) {
      return transaction(scope, async (tx) => {
        const rows = await tx
          .select({
            run: automationRuns,
            decision: automationDecisions,
          })
          .from(automationRuns)
          .innerJoin(
            automations,
            eq(automationRuns.automationId, automations.id),
          )
          .leftJoin(
            automationDecisions,
            eq(automationDecisions.id, automationRuns.id),
          )
          .where(
            and(
              householdWhere(scope),
              automationId ? eq(automations.id, automationId) : undefined,
              sql`(exists (select 1 from ${automationActions} where ${automationActions.runId} = ${automationRuns.id}) or ${automationDecisions.id} is not null)`,
            ),
          )
          .orderBy(desc(automationRuns.createdAt))
          .limit(limit);
        const ids = rows.map(({ run }) => run.id);
        const actions = ids.length
          ? await tx
              .select()
              .from(automationActions)
              .where(inArray(automationActions.runId, ids))
          : [];
        return rows.map(({ run, decision }) => {
          return automationRunSchema.parse({
            id: run.id,
            automation_id: run.automationId,
            revision: run.revision,
            created_at: run.input.at,
            status: run.status,
            reason: run.reason,
            input: {
              kind: run.input.kind,
              captured_at: run.input.at,
              report: run.input.report,
              event: run.input.event ?? null,
              facts: run.input.facts,
            },
            evaluation: run.evaluation,
            evaluation_recorded_at: run.createdAt.toISOString(),
            timing: run.timing,
            decision: decision
              ? {
                  status: decision.status,
                  explanation: decision.result?.explanation ?? null,
                  timing: decision.timing,
                }
              : null,
            actions: actions
              .filter((action) => action.runId === run.id)
              .map((action) => ({
                action_id: action.action.id,
                action: action.action,
                status: action.status,
                reason: action.reason,
                timing: action.timing,
                updated_at: action.updatedAt.toISOString(),
              })),
          });
        });
      });
    },
  };
}
