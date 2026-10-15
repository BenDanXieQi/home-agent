import { tryit } from "radash";
import type { z } from "zod";
import {
  type agentWorkflowInputSchema,
  agentWorkflowResultSchema,
} from "./contracts";
import { AppError } from "@home-agent/api/errors";
import { configureWorkflowRegistry } from "./registry.generated";
import type { WorkflowContext } from "./definition";

export function configureWorkflows(
  config: Parameters<typeof configureWorkflowRegistry>[0],
) {
  const configuration = configureWorkflowRegistry(config);
  return {
    modelRefs: configuration.modelRefs,
    create(context: Omit<WorkflowContext, "modelRef">) {
      return createWorkflows(
        context.budget,
        configuration.createRegistry(context),
      );
    },
  };
}

function createWorkflows(
  budget: WorkflowContext["budget"],
  workflows: ReturnType<
    ReturnType<typeof configureWorkflowRegistry>["createRegistry"]
  >,
) {
  async function execute(
    input: z.output<typeof agentWorkflowInputSchema>,
    signal: AbortSignal,
  ) {
    const output = await workflows.execute(input, signal);
    if (!output.result) throw new AppError("model_not_configured");
    const result = agentWorkflowResultSchema.parse(output);
    signal.throwIfAborted();
    return result;
  }

  async function run(
    input: Parameters<typeof execute>[0],
    requestSignal: AbortSignal,
  ) {
    if (requestSignal.aborted) throw new AppError("request_cancelled");
    const timeoutSignal = AbortSignal.timeout(budget.timeoutMs);
    const signal = AbortSignal.any([requestSignal, timeoutSignal]);
    const [cause, result] = await tryit(execute)(input, signal);
    if (!cause) return result;
    if (requestSignal.aborted)
      throw new AppError("request_cancelled", { cause });
    if (timeoutSignal.aborted) throw new AppError("run_timeout", { cause });
    if (cause instanceof AppError) throw cause;
    throw new AppError("agent_execution_failed", { cause });
  }

  return {
    run,
    retainScope: workflows.retainScope,
    close: workflows.close,
    [Symbol.asyncDispose]: workflows.close,
  };
}
