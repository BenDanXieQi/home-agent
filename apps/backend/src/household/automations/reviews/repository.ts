import { collectAutomationConditions } from "@home-agent/api/automations";
import { automations } from "../../../db/schema";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  automationReviewRunSchema,
  type automationReviewRequestSchema,
  type automationReviewResultSchema,
} from "@home-agent/api/automation-reviews";
import type { Database } from "../../../db";
import type { Transaction } from "../../../db/transaction-outcome";
import { createHouseholdBindingAccess } from "../../binding-repository";
import type { accessHousehold } from "../../access";
import { enqueueAutomationJob } from "../jobs";
import { reserveAutomationModelBudget } from "../model-budget";
import { automationReviews, automationReviewRuns } from "./schema";

type Scope = ReturnType<typeof accessHousehold>;
type Review = NonNullable<Awaited<ReturnType<typeof find>>>;
const active = ["pending", "dispatching", "running"] as const;

const household = (scope: Scope) =>
  and(
    eq(automationReviews.accountId, scope.identity.accountId),
    eq(automationReviews.homeId, scope.identity.homeId),
  );
function project(entry: {
  state: typeof automationReviews.$inferSelect;
  rule: typeof automations.$inferSelect;
}) {
  const condition = collectAutomationConditions(
    entry.rule.definition.tree,
  ).find((node) => node.id === entry.state.nodeId);
  if (
    condition?.predicate.kind !== "ai" ||
    entry.rule.revision !== entry.state.revision
  )
    return undefined;
  return {
    ...entry.state,
    enabled: entry.rule.enabled,
    definition: condition.predicate,
  };
}
async function find(tx: Transaction, scope: Scope, id: string) {
  const [entry] = await tx
    .select({ state: automationReviews, rule: automations })
    .from(automationReviews)
    .innerJoin(automations, eq(automations.id, automationReviews.automationId))
    .where(and(household(scope), eq(automationReviews.id, id)))
    .for("update", { of: automationReviews });
  return entry ? project(entry) : undefined;
}
export async function syncAutomationReviews(
  tx: Transaction,
  rule: typeof automations.$inferSelect,
) {
  const old = await tx
    .select()
    .from(automationReviews)
    .where(eq(automationReviews.automationId, rule.id));
  const nodes = collectAutomationConditions(rule.definition.tree).filter(
    (node) => node.predicate.kind === "ai",
  );
  for (const row of old) {
    if (!nodes.some((node) => node.id === row.nodeId))
      await tx
        .delete(automationReviews)
        .where(eq(automationReviews.id, row.id));
  }
  for (const node of nodes) {
    const existing = old.find((row) => row.nodeId === node.id);
    const data = {
      accountId: rule.accountId,
      homeId: rule.homeId,
      automationId: rule.id,
      nodeId: node.id,
      revision: rule.revision,
      lastFingerprint: null,
      activeRequestId: null,
      nextAt: rule.enabled ? new Date() : null,
      updatedAt: new Date(),
    };
    if (existing) {
      await tx
        .update(automationReviews)
        .set(data)
        .where(eq(automationReviews.id, existing.id));
      await tx
        .update(automationReviewRuns)
        .set({
          status: "cancelled",
          reason: "所属规则已修改或停用",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(automationReviewRuns.reviewId, existing.id),
            inArray(automationReviewRuns.status, [...active]),
          ),
        );
    } else
      await tx
        .insert(automationReviews)
        .values({ id: crypto.randomUUID(), ...data });
  }
}
async function finish(tx: Transaction, review: Review) {
  await tx
    .update(automationReviews)
    .set({ activeRequestId: null })
    .where(eq(automationReviews.id, review.id));
}

export function createAutomationReviewRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  const transaction = <T>(scope: Scope, run: (tx: Transaction) => Promise<T>) =>
    access(scope.identity, scope.assertCurrent, run);
  return {
    transaction,
    async list(scope: Scope) {
      return transaction(scope, async (tx) => {
        const entries = await tx
          .select({ state: automationReviews, rule: automations })
          .from(automationReviews)
          .innerJoin(
            automations,
            eq(automations.id, automationReviews.automationId),
          )
          .where(household(scope));
        return entries.flatMap((entry) => {
          const row = project(entry);
          return row ? [row] : [];
        });
      });
    },
    takeDue(scope: Scope, id: string) {
      return transaction(scope, async (tx) => {
        const row = await find(tx, scope, id);
        if (!row?.enabled || !row.nextAt || row.nextAt.getTime() > Date.now())
          return undefined;
        // Advance the normal schedule before capturing evidence. A failed cycle is lost.
        const [scheduled] = await tx
          .update(automationReviews)
          .set({
            nextAt: new Date(
              Date.now() + row.definition.interval_seconds * 1000,
            ),
          })
          .where(eq(automationReviews.id, id))
          .returning();
        return scheduled ? { ...row, ...scheduled } : undefined;
      });
    },
    async startSchedules(scope: Scope) {
      return transaction(scope, async (tx) => {
        const rows = await tx
          .select()
          .from(automationReviews)
          .where(household(scope))
          .for("update");
        for (const row of rows) {
          await tx
            .update(automationReviewRuns)
            .set({
              status: "unknown",
              reason: "运行期已结束，未完成的复核不再补跑",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(automationReviewRuns.reviewId, row.id),
                inArray(automationReviewRuns.status, [...active]),
              ),
            );
          await tx
            .update(automationReviews)
            .set({
              activeRequestId: null,
              nextAt:
                row.nextAt && row.nextAt.getTime() > Date.now()
                  ? row.nextAt
                  : new Date(Date.now() + 60_000),
            })
            .where(eq(automationReviews.id, row.id));
        }
        return rows;
      });
    },
    async admit(
      scope: Scope,
      id: string,
      revision: number,
      candidate: {
        request: ReturnType<typeof automationReviewRequestSchema.parse>;
        fingerprint: string;
        reason: string | null;
      },
    ) {
      return transaction(scope, async (tx) => {
        const row = await find(tx, scope, id);
        if (!row?.enabled || row.revision !== revision) return;
        if (row.activeRequestId) {
          const [unfinished] = await tx
            .select()
            .from(automationReviewRuns)
            .where(eq(automationReviewRuns.id, row.activeRequestId));
          if (
            !unfinished?.request ||
            Date.parse(unfinished.request.expires_at) <= Date.now()
          ) {
            await tx
              .update(automationReviewRuns)
              .set({
                status: "unknown",
                reason: "复核已过期，本次执行已结束",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(automationReviewRuns.id, row.activeRequestId),
                  inArray(automationReviewRuns.status, [...active]),
                ),
              );
            row.activeRequestId = null;
            await tx
              .update(automationReviews)
              .set({ activeRequestId: null })
              .where(eq(automationReviews.id, id));
          }
        }
        if (row.activeRequestId) return;
        const today = new Date(Date.now() - 24 * 3600_000);
        const used = await tx.$count(
          automationReviewRuns,
          and(
            eq(automationReviewRuns.reviewId, id),
            gte(automationReviewRuns.createdAt, today),
            isNotNull(automationReviewRuns.request),
          ),
        );
        let reason =
          candidate.reason ??
          (used >= row.definition.max_calls_per_day
            ? "已达到过去 24 小时模型调用预算"
            : !row.definition.evaluate_unchanged &&
                row.lastFingerprint === candidate.fingerprint
              ? "相关证据未变化"
              : null);
        if (
          !reason &&
          !(await reserveAutomationModelBudget(
            tx,
            candidate.request.request_id,
            scope.identity,
          ))
        )
          reason = "家庭自动化已达到每小时模型调用预算";
        await tx.insert(automationReviewRuns).values({
          id: candidate.request.request_id,
          reviewId: id,
          revision,
          status: reason ? "skipped" : "pending",
          reason,
          request: reason ? null : candidate.request,
          fingerprint: candidate.fingerprint,
        });
        if (!reason) {
          await tx
            .update(automationReviews)
            .set({
              activeRequestId: candidate.request.request_id,
              lastFingerprint: candidate.fingerprint,
            })
            .where(eq(automationReviews.id, id));
          await enqueueAutomationJob(
            tx,
            "automation_review_execute",
            { id: candidate.request.request_id },
            `review-execute:${candidate.request.request_id}`,
          );
        }
        // Requests are never dispatched after their two-minute admission TTL.
        // Keep terminal history for seven days, beyond both budget windows.
        await tx.execute(
          sql`delete from automation_review_runs where review_id=${id}::uuid and status not in ('pending','dispatching','running') and created_at < now()-interval '7 days'`,
        );
      });
    },
    async claim(scope: Scope, id: string) {
      return transaction(scope, async (tx) => {
        const [candidate] = await tx
          .select()
          .from(automationReviewRuns)
          .where(eq(automationReviewRuns.id, id));
        if (!candidate) return undefined;
        const row = await find(tx, scope, candidate.reviewId);
        const [run] = await tx
          .select()
          .from(automationReviewRuns)
          .where(eq(automationReviewRuns.id, id))
          .for("update");
        if (!row || !run || run.status !== "pending") return undefined;
        if (
          !row.enabled ||
          row.revision !== run.revision ||
          row.activeRequestId !== id ||
          !run.request ||
          run.request.context.scope_epoch !== scope.snapshot.scope_epoch
        ) {
          await tx
            .update(automationReviewRuns)
            .set({
              status: "cancelled",
              reason: "维护或家庭已变更",
              updatedAt: new Date(),
            })
            .where(eq(automationReviewRuns.id, id));
          if (row.activeRequestId === id) await finish(tx, row);
          return undefined;
        }
        if (Date.parse(run.request.expires_at) <= Date.now()) {
          await tx
            .update(automationReviewRuns)
            .set({
              status: "cancelled",
              reason: "复核结果已超过接纳期限",
              updatedAt: new Date(),
            })
            .where(eq(automationReviewRuns.id, id));
          await finish(tx, row);
          return undefined;
        }
        await tx
          .update(automationReviewRuns)
          .set({ status: "dispatching", updatedAt: new Date() })
          .where(eq(automationReviewRuns.id, id));
        return { review: row, request: run.request };
      });
    },
    async complete(
      scope: Scope,
      id: string,
      outcome: {
        status: "succeeded" | "unknown" | "failed" | "cancelled";
        reason: string | null;
        result: ReturnType<typeof automationReviewResultSchema.parse> | null;
      },
    ) {
      return transaction(scope, async (tx) => {
        const [candidate] = await tx
          .select()
          .from(automationReviewRuns)
          .where(eq(automationReviewRuns.id, id));
        if (!candidate) return undefined;
        const review = await find(tx, scope, candidate.reviewId);
        const [run] = await tx
          .select()
          .from(automationReviewRuns)
          .where(eq(automationReviewRuns.id, id))
          .for("update");
        if (!review || !run || !active.some((status) => status === run.status))
          return undefined;
        if (
          !review.enabled ||
          review.revision !== run.revision ||
          review.activeRequestId !== id ||
          !run.request
        )
          return undefined;
        if (Date.parse(run.request.expires_at) <= Date.now()) {
          await tx
            .update(automationReviewRuns)
            .set({
              status: "unknown",
              reason: "复核结果已超过接纳期限",
              updatedAt: new Date(),
            })
            .where(eq(automationReviewRuns.id, id));
          await finish(tx, review);
          return undefined;
        }
        await tx
          .update(automationReviewRuns)
          .set({ ...outcome, updatedAt: new Date() })
          .where(eq(automationReviewRuns.id, id));
        await finish(tx, review);
        return true;
      });
    },
    async runs(scope: Scope, automationId: string, limit: number) {
      return transaction(scope, async (tx) => {
        const rows = await tx
          .select({
            run: automationReviewRuns,
            nodeId: automationReviews.nodeId,
          })
          .from(automationReviewRuns)
          .innerJoin(
            automationReviews,
            eq(automationReviewRuns.reviewId, automationReviews.id),
          )
          .where(
            and(
              household(scope),
              eq(automationReviews.automationId, automationId),
            ),
          )
          .orderBy(desc(automationReviewRuns.createdAt))
          .limit(limit);
        return rows.map(({ run, nodeId }) =>
          automationReviewRunSchema.parse({
            node_id: nodeId,
            request_id: run.id,
            review_id: run.reviewId,
            revision: run.revision,
            status: run.status,
            reason: run.reason,
            request: run.request,
            result: run.result,
            created_at: run.createdAt.toISOString(),
            updated_at: run.updatedAt.toISOString(),
          }),
        );
      });
    },
  };
}
