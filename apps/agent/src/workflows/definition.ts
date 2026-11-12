import type { z } from "zod";
import { AppError } from "@home-agent/api/errors";
import type {
  agentWorkflowInputSchema,
  agentWorkflowStreamContract,
} from "./contracts.generated";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { initializeModelRuntime } from "../models";
import type { createAgentRuntime } from "../runtime";
import type { createContextReader } from "../context/reader";

type WorkflowContext = {
  harness: WorkflowDependencies["harness"];
  modelRuntime: Awaited<ReturnType<typeof initializeModelRuntime>>;
  modelRef: ModelRef | undefined;
  contextReader: WorkflowDependencies["contextReader"];
};

type WorkflowInput = z.output<typeof agentWorkflowInputSchema>;
type WorkflowResult = z.output<typeof agentWorkflowStreamContract.result>;

export type WorkflowInstance = {
  run: unknown;
  reset?: (() => Promise<void>) | undefined;
  close?: (() => Promise<void>) | undefined;
};

type ModelRuntime = Awaited<ReturnType<typeof initializeModelRuntime>>;

export type WorkflowDependencies = Pick<
  Awaited<ReturnType<typeof createAgentRuntime>>,
  "harness"
> & {
  model: NonNullable<ReturnType<ModelRuntime["findAvailableModel"]>>;
  contextReader: ReturnType<typeof createContextReader>;
};

export function defineWorkflow<T extends WorkflowInstance>(
  create: (dependencies: WorkflowDependencies) => T,
  { harness, modelRuntime, modelRef, contextReader }: WorkflowContext,
) {
  const model = modelRuntime.findAvailableModel(modelRef);
  if (!model) return { run: undefined };

  return create({ model, harness, contextReader });
}

export async function closeWorkflow(instance: WorkflowInstance) {
  await instance.close?.();
}

export async function runWorkflow<Input, Result, Progress>(
  run:
    | ((
        input: Input,
        signal: AbortSignal,
        receive?: (progress: Progress) => Promise<void>,
      ) => Promise<unknown>)
    | undefined,
  contract: { progress: z.ZodType<Progress>; result: z.ZodType<Result> },
  input: Input,
  signal: AbortSignal,
  receive?: (progress: Progress) => Promise<void>,
) {
  if (signal.aborted) throw new AppError("request_cancelled");
  try {
    if (!run) throw new AppError("model_not_configured");
    const output = contract.result.parse(
      await run(
        input,
        signal,
        receive
          ? async (progress) => {
              await receive(contract.progress.parse(progress));
            }
          : undefined,
      ),
    );
    signal.throwIfAborted();
    return output;
  } catch (cause) {
    if (signal.aborted) throw new AppError("request_cancelled", { cause });
    if (cause instanceof AppError) throw cause;
    throw new AppError("agent_execution_failed", { cause });
  }
}

export type WorkflowRegistry = {
  [Name in WorkflowInput["workflow"]]: WorkflowInstance & {
    run:
      | ((
          input: Extract<WorkflowInput, { workflow: Name }>["input"],
          signal: AbortSignal,
        ) => Promise<Extract<WorkflowResult, { workflow: Name }>["result"]>)
      | undefined;
  };
};
