import type { z } from "zod";
import type { Models, Model, Api } from "@earendil-works/pi-ai";
import {
  type agentWorkflowInputSchema,
  agentWorkflowResultSchema,
  agentWorkflowLimits,
} from "@home-agent/api/agent-workflows";
import { AppError } from "@home-agent/api/errors";
import { createAutomationGeneration } from "./automation-generation";
import { createSpeechDialogueInterpreter } from "./speech-interpretation";
import { speechDialogueLimits } from "@home-agent/api/speech-dialogue";

export function createWorkflows(
  models: Models,
  selected: Record<
    z.infer<typeof agentWorkflowInputSchema>["workflow"],
    Model<Api> | undefined
  >,
  budget: Parameters<typeof createAutomationGeneration>[2],
) {
  const generate = createAutomationGeneration(
    models,
    selected["automation-generation"],
    budget,
  );
  const interpret = createSpeechDialogueInterpreter(
    models,
    selected["speech-interpretation"],
  );
  const active = { "automation-generation": 0, "speech-interpretation": 0 };

  return async (
    input: z.output<typeof agentWorkflowInputSchema>,
    requestSignal: AbortSignal,
  ) => {
    if (requestSignal.aborted) throw new AppError("request_cancelled");
    const limits =
      input.workflow === "speech-interpretation"
        ? {
            ...agentWorkflowLimits,
            requestBytes: speechDialogueLimits.requestBytes,
            responseBytes: speechDialogueLimits.responseBytes,
            timeoutMs: speechDialogueLimits.agentTimeoutMs,
          }
        : agentWorkflowLimits;
    if (Buffer.byteLength(JSON.stringify(input)) > limits.requestBytes)
      throw new AppError("request_too_large");
    if (active[input.workflow] >= limits.concurrent)
      throw new AppError("workflow_busy");
    const timeout = AbortSignal.timeout(
      Math.min(budget.timeoutMs, limits.timeoutMs),
    );
    const signal = AbortSignal.any([requestSignal, timeout]);
    active[input.workflow]++;
    try {
      const output =
        input.workflow === "automation-generation"
          ? {
              workflow: input.workflow,
              result: await generate?.(input.input, signal),
            }
          : {
              workflow: input.workflow,
              result: await interpret?.(input.input, signal),
            };
      if (!output.result) throw new AppError("model_not_configured");
      const result = agentWorkflowResultSchema.parse(output);
      signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(result)) > limits.responseBytes)
        throw new AppError("agent_execution_failed");
      return result;
    } catch (cause) {
      if (requestSignal.aborted)
        throw new AppError("request_cancelled", { cause });
      if (timeout.aborted) throw new AppError("run_timeout", { cause });
      if (cause instanceof AppError) throw cause;
      throw new AppError("agent_execution_failed", { cause });
    } finally {
      active[input.workflow]--;
    }
  };
}
