import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import {
  householdWorkflowInputSchema,
  agentWorkflowInputSchema,
  agentWorkflowLimits,
} from "@home-agent/api/agent-workflows";
import { validateAutomationCapabilities } from "@home-agent/api/automations";
import type { createAgentClient } from "../agent-client";
import type { HouseholdRuntime } from "../household/runtime";
import { accessHousehold } from "../household/access";
import { HouseholdError } from "../household/errors";
import { householdHttpError } from "../household/http-errors";
import { readAutomationCapabilities } from "../household/automations/capabilities";

export function createWorkflowRoutes({
  port,
  timeoutMs,
  agent,
  household,
  shutdownSignal,
}: {
  port: number;
  timeoutMs: number;
  agent: Pick<ReturnType<typeof createAgentClient>, "workflow">;
  household: HouseholdRuntime;
  shutdownSignal: AbortSignal;
}) {
  return new Hono()
    .use(requireLocalAccess([port, 5173], { webEntry: true }))
    .post(
      "/",
      bodyLimit({
        maxSize: agentWorkflowLimits.requestBytes,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
      validateJson(householdWorkflowInputSchema),
      async (c) => {
        c.header("Cache-Control", "no-store");
        const input = c.req.valid("json");
        const timeout = AbortSignal.timeout(
          Math.min(timeoutMs, agentWorkflowLimits.timeoutMs),
        );
        const revoked = new AbortController();
        const signal = AbortSignal.any([
          c.req.raw.signal,
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
            input: {
              ...input.input,
              capabilities: readAutomationCapabilities(household),
            },
          });
          signal.throwIfAborted();
          current.assertCurrent();
          const result = await agent.workflow(request, signal);
          signal.throwIfAborted();
          current.assertCurrent();
          if (result.workflow !== input.workflow)
            throw new AppError("agent_execution_failed");
          if (result.result.definition) {
            const problems = validateAutomationCapabilities(
              result.result.definition,
              readAutomationCapabilities(household),
            );
            if (problems.length)
              return c.json({
                workflow: result.workflow,
                result: {
                  definition: null,
                  behavior: "生成期间设备能力发生变化，请核对后重新生成。",
                  clarifications: problems.slice(0, 5),
                },
              });
          }
          return c.json(result);
        } catch (cause) {
          if (revoked.signal.aborted)
            throw new AppError("household_scope_changed", { cause });
          if (c.req.raw.signal.aborted || shutdownSignal.aborted)
            throw new AppError("request_cancelled", { cause });
          if (timeout.aborted) throw new AppError("agent_timeout", { cause });
          if (cause instanceof HouseholdError) throw householdHttpError(cause);
          if (cause instanceof AppError) throw cause;
          throw new AppError("agent_unavailable", { cause });
        } finally {
          unsubscribe();
        }
      },
    );
}
