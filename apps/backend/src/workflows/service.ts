import type { z } from "zod";
import { agentWorkflowInputSchema } from "@home-agent/agent/workflows";
import { validateAutomationCapabilities } from "@home-agent/api/automations";
import { AppError } from "@home-agent/api/errors";
import type { householdWorkflowInputSchema } from "./contracts";
import type { createAgentClient } from "../agent-client";
import type { HouseholdRuntime } from "../household/runtime";
import { accessHousehold } from "../household/access";
import { HouseholdError } from "../household/errors";
import { readAutomationCapabilities } from "../household/automations/capabilities";

export function createHouseholdWorkflows({
  timeoutMs,
  agent,
  household,
  shutdownSignal,
}: {
  timeoutMs: number;
  agent: Pick<ReturnType<typeof createAgentClient>, "workflow">;
  household: HouseholdRuntime;
  shutdownSignal: AbortSignal;
}) {
  async function run(
    input: z.output<typeof householdWorkflowInputSchema>,
    requestSignal: AbortSignal,
  ) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const revoked = new AbortController();
    const signal = AbortSignal.any([
      requestSignal,
      shutdownSignal,
      timeout,
      revoked.signal,
    ]);
    const unsubscribe = household.subscribe(() => {
      if (!household.ready || household.epoch !== input.scope_epoch)
        revoked.abort();
    });
    try {
      const current = accessHousehold(household, input.scope_epoch);
      const request = agentWorkflowInputSchema.parse({
        workflow: input.workflow,
        input:
          input.workflow === "automation-generation"
            ? {
                ...input.input,
                capabilities: readAutomationCapabilities(household),
              }
            : {
                ...input.input,
                scope: {
                  account_id: current.identity.accountId,
                  home_id: current.identity.homeId,
                  scope_epoch: current.snapshot.scope_epoch,
                },
              },
      });
      signal.throwIfAborted();
      current.assertCurrent();
      const result = await agent.workflow(request, signal);
      signal.throwIfAborted();
      current.assertCurrent();
      if (result.workflow !== input.workflow)
        throw new AppError("agent_execution_failed");
      if (
        result.workflow === "automation-generation" &&
        result.result.definition
      ) {
        const problems = validateAutomationCapabilities(
          result.result.definition,
          readAutomationCapabilities(household),
        );
        if (problems.length)
          return {
            workflow: result.workflow,
            result: {
              definition: null,
              behavior: "生成期间设备能力发生变化，请核对后重新生成。",
              clarifications: problems,
            },
          };
      }
      return result;
    } catch (cause) {
      if (revoked.signal.aborted)
        throw new AppError("household_scope_changed", { cause });
      if (requestSignal.aborted || shutdownSignal.aborted)
        throw new AppError("request_cancelled", { cause });
      if (timeout.aborted) throw new AppError("agent_timeout", { cause });
      if (cause instanceof HouseholdError || cause instanceof AppError)
        throw cause;
      throw new AppError("agent_unavailable", { cause });
    } finally {
      unsubscribe();
    }
  }

  return { run };
}
