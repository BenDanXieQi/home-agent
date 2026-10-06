import { createAutomationDecisionClient } from "./decision-client";
import { AppError } from "@home-agent/api/errors";
import { and, eq } from "drizzle-orm";
import {
  automationDecisionInputSchema,
  automationDecisionReceiptSchema,
  automationDecisionLimits,
} from "@home-agent/api/automations";
import {
  automations,
  automationDecisions,
  automationRuns,
} from "../../db/schema";
import type { Database } from "../../db";
import { createHouseholdBindingAccess } from "../binding-repository";
import type { accessHousehold } from "../access";
import { lockAutomationRun } from "./repository";
import { createAutomationExecution } from "./execution";
import { reserveAutomationModelBudget } from "./model-budget";
import type { createAutomationActions } from "./actions";

type Scope = ReturnType<typeof accessHousehold>;
export function createAutomationDecisions(deps: {
  db: Database;
  scope: () => Scope;
  signal: AbortSignal;
  readAgentUrl: () => Promise<string>;
  eligible: Parameters<typeof createAutomationActions>[0]["eligible"];
  schedule: ReturnType<typeof createAutomationActions>["schedule"];
  isCurrent: Parameters<typeof createAutomationActions>[0]["isCurrent"];
}) {
  const access = createHouseholdBindingAccess(deps.db);
  const call = createAutomationDecisionClient(deps.readAgentUrl);
  const controllers = new Map<
    string,
    { automationId: string; controller: AbortController }
  >();
  async function settle(
    scope: Scope,
    id: string,
    receipt: ReturnType<typeof automationDecisionReceiptSchema.parse>,
    responseReceivedAt?: string,
    rejection?: AppError,
  ) {
    const execution = await access(
      scope.identity,
      scope.assertCurrent,
      async (tx) => {
        if (!(await lockAutomationRun(tx, scope, id))) return undefined;
        const [row] = await tx
          .select({
            decision: automationDecisions,
            run: automationRuns,
            definition: automations,
            input: automationRuns.input,
          })
          .from(automationDecisions)
          .innerJoin(
            automationRuns,
            eq(automationDecisions.id, automationRuns.id),
          )
          .innerJoin(
            automations,
            eq(automationRuns.automationId, automations.id),
          )
          .where(
            and(
              eq(automationDecisions.id, id),
              eq(automations.accountId, scope.identity.accountId),
              eq(automations.homeId, scope.identity.homeId),
            ),
          )
          .for("update");
        if (!row || !["pending", "dispatching"].includes(row.decision.status))
          return undefined;
        await tx
          .update(automationDecisions)
          .set({
            timing: {
              ...row.decision.timing,
              ...(responseReceivedAt
                ? { response_received_at: responseReceivedAt }
                : {}),
              settled_at: new Date().toISOString(),
            },
          })
          .where(eq(automationDecisions.id, id));
        const current =
          row.definition.enabled &&
          row.definition.revision === row.run.revision &&
          row.input.scope_epoch === scope.snapshot.scope_epoch &&
          row.run.expiresAt.getTime() > Date.now() &&
          deps.isCurrent(row.definition.id, row.run.revision) &&
          deps.eligible(
            row.definition.id,
            row.definition.definition,
            row.input,
            row.run.evaluation,
          );
        if (!current) {
          await tx
            .update(automationDecisions)
            .set({ status: "cancelled", updatedAt: new Date() })
            .where(eq(automationDecisions.id, id));
          await tx
            .update(automationRuns)
            .set({
              status: "cancelled",
              reason: "决策返回时规则、触发依据或启动期限已失效",
            })
            .where(eq(automationRuns.id, id));
          return undefined;
        }
        if (receipt.request_id !== id)
          throw new Error("Decision receipt identity mismatch");
        const result = receipt.result;
        const ids = result?.action_ids ?? [];
        const valid =
          receipt.request_id === id &&
          receipt.status === "succeeded" &&
          result !== null &&
          new Set(ids).size === ids.length &&
          ids.every((actionId) =>
            row.decision.input.allowed_actions.some(
              (action) => action.id === actionId,
            ),
          );
        if (!valid) {
          await tx
            .update(automationDecisions)
            .set({
              status: rejection ? "failed" : "unknown",
              updatedAt: new Date(),
            })
            .where(eq(automationDecisions.id, id));
          await tx
            .update(automationRuns)
            .set({
              status:
                rejection?.code === "request_too_large"
                  ? "skipped"
                  : rejection
                    ? "failed"
                    : "unknown",
              reason:
                rejection?.code === "request_too_large"
                  ? "Agent 决策输入超过模型上下文容量，本次已跳过"
                  : rejection
                    ? `Agent 未接纳决策：${rejection.code}`
                    : "Agent 决策结果未确认，本次执行已结束",
            })
            .where(eq(automationRuns.id, id));
          return undefined;
        }
        await tx
          .update(automationDecisions)
          .set({ status: "completed", result, updatedAt: new Date() })
          .where(eq(automationDecisions.id, id));
        await tx
          .update(automationRuns)
          .set({
            status: ids.length ? "pending" : "succeeded",
            reason: result.explanation,
          })
          .where(eq(automationRuns.id, id));
        if (ids.length)
          return createAutomationExecution(
            row.definition,
            row.input,
            row.run.evaluation,
            row.run.timing,
            id,
            row.decision.input.allowed_actions.filter((action) =>
              ids.includes(action.id),
            ),
          );
        return undefined;
      },
    );
    if (execution) deps.schedule(scope, execution);
  }
  return {
    async execute(id: string) {
      const scope = deps.scope();
      const claimed = await access(
        scope.identity,
        scope.assertCurrent,
        async (tx) => {
          if (!(await lockAutomationRun(tx, scope, id))) return undefined;
          const [row] = await tx
            .select({
              decision: automationDecisions,
              run: automationRuns,
              definition: automations,
              input: automationRuns.input,
            })
            .from(automationDecisions)
            .innerJoin(
              automationRuns,
              eq(automationDecisions.id, automationRuns.id),
            )
            .innerJoin(
              automations,
              eq(automationRuns.automationId, automations.id),
            )
            .where(
              and(
                eq(automationDecisions.id, id),
                eq(automations.accountId, scope.identity.accountId),
                eq(automations.homeId, scope.identity.homeId),
              ),
            )
            .for("update");
          if (!row || row.decision.status !== "pending") return undefined;
          if (
            row.input.scope_epoch !== scope.snapshot.scope_epoch ||
            !row.definition.enabled ||
            row.definition.revision !== row.run.revision ||
            row.run.expiresAt.getTime() <= Date.now() ||
            !deps.isCurrent(row.definition.id, row.run.revision) ||
            !deps.eligible(
              row.definition.id,
              row.definition.definition,
              row.input,
              row.run.evaluation,
            )
          ) {
            await tx
              .update(automationDecisions)
              .set({ status: "cancelled", updatedAt: new Date() })
              .where(eq(automationDecisions.id, id));
            await tx
              .update(automationRuns)
              .set({ status: "cancelled", reason: "Agent 决策启动资格已失效" })
              .where(eq(automationRuns.id, id));
            return undefined;
          }
          if (
            Buffer.byteLength(JSON.stringify(row.decision.input)) >
            automationDecisionLimits.requestBytes
          ) {
            await tx
              .update(automationDecisions)
              .set({ status: "cancelled", updatedAt: new Date() })
              .where(eq(automationDecisions.id, id));
            await tx
              .update(automationRuns)
              .set({
                status: "skipped",
                reason:
                  "Agent 决策请求超过容量上限，本次已跳过，设备证据未截断",
              })
              .where(eq(automationRuns.id, id));
            return undefined;
          }
          if (!(await reserveAutomationModelBudget(tx, id, scope.identity))) {
            await tx
              .update(automationDecisions)
              .set({ status: "cancelled", updatedAt: new Date() })
              .where(eq(automationDecisions.id, id));
            await tx
              .update(automationRuns)
              .set({ status: "skipped", reason: "自动化共用模型预算已用完" })
              .where(eq(automationRuns.id, id));
            return undefined;
          }
          await tx
            .update(automationDecisions)
            .set({
              status: "dispatching",
              updatedAt: new Date(),
              timing: {
                ...row.decision.timing,
                requested_at:
                  row.decision.timing.requested_at ?? new Date().toISOString(),
              },
            })
            .where(eq(automationDecisions.id, id));
          await tx
            .update(automationRuns)
            .set({ status: "running", reason: "等待 Agent 选择已授权动作" })
            .where(eq(automationRuns.id, id));
          return {
            input: automationDecisionInputSchema.parse(row.decision.input),
          };
        },
      );
      if (!claimed) return;
      const controller = new AbortController();
      controllers.set(id, {
        automationId: claimed.input.automation_id,
        controller,
      });
      const signal = AbortSignal.any([
        deps.signal,
        controller.signal,
        AbortSignal.timeout(
          Math.max(
            1,
            Math.min(
              automationDecisionLimits.timeoutMs,
              Date.parse(claimed.input.expires_at) - Date.now(),
            ),
          ),
        ),
      ]);
      try {
        const receipt = await call(claimed.input, signal);
        await settle(scope, id, receipt, new Date().toISOString());
      } catch (error) {
        console.warn(
          "自动化决策失败，本次执行已结束",
          error instanceof Error ? error.name : "unknown",
        );
        await settle(
          scope,
          id,
          { request_id: id, status: "unknown", result: null },
          undefined,
          error instanceof AppError ? error : undefined,
        );
      } finally {
        controllers.delete(id);
      }
    },
    cancel(automationId?: string) {
      for (const value of controllers.values())
        if (!automationId || value.automationId === automationId)
          value.controller.abort();
    },
  };
}
