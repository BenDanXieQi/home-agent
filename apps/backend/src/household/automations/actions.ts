import PQueue from "p-queue";
import type { HouseholdRuntime } from "../runtime";
import type { Database } from "../../db";
import type { accessHousehold } from "../access";
import type { createDeviceOperations } from "../operations/service";
import { createAutomationRepository } from "./repository";
import {
  summarizeAutomationActions,
  type createAutomationExecution,
} from "./execution";
import type { automationInputSchema } from "./state";
import type { z } from "zod";
import type {
  AutomationDefinition,
  AutomationEvaluation,
} from "@home-agent/api/automations";

type Scope = ReturnType<typeof accessHousehold>;
function logFailure(error: unknown) {
  console.warn(
    "自动化执行记录未保存，设备动作不会重发",
    error instanceof Error ? error.name : "unknown",
  );
}

export function createAutomationActions(deps: {
  db: Database;
  operations: ReturnType<typeof createDeviceOperations>;
  signal: AbortSignal;
  snapshot: HouseholdRuntime["snapshot"];
  eligible: (
    automationId: string,
    definition: AutomationDefinition,
    input: z.infer<typeof automationInputSchema>,
    evaluation: AutomationEvaluation,
  ) => boolean;
  isCurrent: (id: string, revision: number) => boolean;
}) {
  const operations = deps.operations;
  const repository = createAutomationRepository(deps.db);
  const controls = new PQueue({ concurrency: 4 });
  const logs = new PQueue({ concurrency: 1 });
  const executions = new Map<string, Promise<void>>();
  const controller = new AbortController();
  const executionSignal = AbortSignal.any([deps.signal, controller.signal]);
  let pending = 0;
  let stopped = false;

  function record(
    scope: Scope,
    execution: ReturnType<typeof createAutomationExecution>,
  ) {
    if (logs.size + logs.pending >= 256) {
      console.warn("自动化执行记录繁忙，本次记录已丢弃，设备动作不会重发");
      return;
    }
    logs
      .add(async () => {
        await repository.recordExecution(scope, execution);
      })
      .catch(logFailure);
  }
  async function execute(
    scope: Scope,
    execution: ReturnType<typeof createAutomationExecution>,
    row: ReturnType<typeof createAutomationExecution>["actions"][number],
  ) {
    const assertCurrent = () => {
      scope.assertCurrent();
      executionSignal.throwIfAborted();
      if (
        !deps.isCurrent(execution.run.automationId, execution.run.revision) ||
        execution.run.expiresAt.getTime() <= Date.now() ||
        !deps.eligible(
          execution.run.automationId,
          execution.definition,
          execution.run.input,
          execution.run.evaluation,
        )
      )
        throw new Error("Action eligibility revoked");
    };
    let status = "unknown";
    let reason: string | null = "设备操作结果未确认，请核对设备；不会自动重发";
    const timing = row.timing;
    timing.claimed_at = new Date().toISOString();
    try {
      assertCurrent();
      timing.prepared_at = new Date().toISOString();
      row.status = "running";
      const action = row.action;
      if (action.kind === "notification") {
        status = "succeeded";
        reason = "通知已保存，可在自动化执行记录中查看";
      } else {
        const signal = AbortSignal.any([
          executionSignal,
          AbortSignal.timeout(
            Math.min(
              15_000,
              Math.max(1, execution.run.expiresAt.getTime() - Date.now()),
            ),
          ),
        ]);
        const parts = (
          action.kind === "set_property"
            ? action.property_key
            : action.action_key
        ).split(".");
        timing.dispatch_started_at = new Date().toISOString();
        timing.command_id = row.id;
        const command =
          action.kind === "set_property"
            ? await operations.executePropertyWrite(
                scope,
                execution.source,
                {
                  device_id: action.device_id,
                  siid: Number(parts[1]),
                  piid: Number(parts[2]),
                  value: action.value,
                },
                signal,
                assertCurrent,
                row.id,
              )
            : await operations.executeDeviceAction(
                scope,
                execution.source,
                {
                  device_id: action.device_id,
                  siid: Number(parts[1]),
                  aiid: Number(parts[2]),
                  inputs: action.inputs,
                },
                signal,
                assertCurrent,
                row.id,
              );
        timing.command_id = command.command_id;
        const result = command.result;
        if (result) {
          if (result.sent_at) timing.sent_at = result.sent_at;
          if (result.received_at)
            timing.response_received_at = result.received_at;
          status = result.status;
          reason =
            result.status === "accepted"
              ? "设备服务已接纳请求，实际效果尚待核对"
              : result.status === "rejected"
                ? `设备服务拒绝请求（${result.provider_code ?? "未知代码"}）`
                : reason;
        }
      }
    } catch {
      status = "cancelled";
      reason = "发送前资格或设备能力核对失败，动作未发送";
    }
    timing.finished_at = new Date().toISOString();
    row.status = status;
    row.reason = reason;
    row.updatedAt = new Date();
  }

  return {
    schedule(
      scope: Scope,
      execution: ReturnType<typeof createAutomationExecution>,
    ) {
      if (
        stopped ||
        executionSignal.aborted ||
        executions.has(execution.run.id)
      )
        return;
      if (pending + execution.actions.length > 256) {
        console.warn("自动化动作队列已满，本次执行已丢弃");
        for (const row of execution.actions) {
          row.status = "cancelled";
          row.reason = "动作队列已满";
          row.timing.finished_at = new Date().toISOString();
        }
        Object.assign(
          execution.run,
          summarizeAutomationActions(execution.actions),
        );
        record(scope, execution);
        return;
      }
      pending += execution.actions.length;
      // MijiaCommands owns per-device ordering; this queue only limits concurrency.
      const tasks = execution.actions.map((row) =>
        controls.add(() => execute(scope, execution, row)),
      );
      const completion = Promise.allSettled(tasks)
        .then((results) => {
          for (const [index, result] of results.entries()) {
            if (result.status !== "rejected") continue;
            const row = execution.actions[index]!;
            row.status = "unknown";
            row.reason = "动作执行中断，结果未确认；不会自动重发";
            row.timing.finished_at = new Date().toISOString();
          }
          Object.assign(
            execution.run,
            summarizeAutomationActions(execution.actions),
          );
          record(scope, execution);
        })
        .catch(logFailure)
        .finally(() => {
          pending -= execution.actions.length;
          executions.delete(execution.run.id);
        });
      executions.set(execution.run.id, completion);
    },
    async close() {
      stopped = true;
      controller.abort();
      await Promise.all(executions.values());
      await logs.onIdle();
    },
  };
}
