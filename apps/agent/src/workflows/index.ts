import type { z } from "zod";
import {
  type agentWorkflowInputSchema,
  agentWorkflowResultSchema,
  agentWorkflowLimits,
} from "@home-agent/api/agent-workflows";
import { AppError } from "@home-agent/api/errors";
import type { Config } from "../config";
import { createAutomationGeneration } from "./automation-generation";

export function createWorkflows(config: Config) {
  const generate = createAutomationGeneration(config);
  let active = 0;

  return async (
    input: z.output<typeof agentWorkflowInputSchema>,
    requestSignal: AbortSignal,
  ) => {
    if (requestSignal.aborted) throw new AppError("request_cancelled");
    if (!generate) throw new AppError("model_not_configured");
    if (active >= agentWorkflowLimits.concurrent)
      throw new AppError("workflow_busy");
    const timeout = AbortSignal.timeout(
      Math.min(config.AGENT_RUN_TIMEOUT_MS, agentWorkflowLimits.timeoutMs),
    );
    const signal = AbortSignal.any([requestSignal, timeout]);
    active++;
    try {
      const result = agentWorkflowResultSchema.parse({
        workflow: input.workflow,
        result: await generate(input.input, signal),
      });
      signal.throwIfAborted();
      if (
        Buffer.byteLength(JSON.stringify(result)) >
        agentWorkflowLimits.responseBytes
      )
        throw new AppError("agent_execution_failed");
      return result;
    } catch (cause) {
      if (requestSignal.aborted)
        throw new AppError("request_cancelled", { cause });
      if (timeout.aborted) throw new AppError("run_timeout", { cause });
      if (cause instanceof AppError) throw cause;
      throw new AppError("agent_execution_failed", { cause });
    } finally {
      active--;
    }
  };
}
