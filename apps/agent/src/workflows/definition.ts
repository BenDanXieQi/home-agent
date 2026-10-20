import type { z } from "zod";
import { tryit } from "radash";
import { AppError } from "@home-agent/api/errors";
import type {
  agentWorkflowInputSchema,
  agentWorkflowStreamContract,
} from "./contracts.generated";
import { resource, type Handle, type Self } from "@earendil-works/chord";
import type { ModelRef } from "@earendil-works/pi-durable";
import { AgentModels } from "../models";
import { AgentRuntime, getServiceInstance } from "../runtime";
import type { createContextReader } from "../context/reader";

type WorkflowContext = {
  self: Self;
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

type ModelRuntime = NonNullable<Handle<typeof AgentModels>["instance"]>;

export type WorkflowDependencies = Pick<
  NonNullable<Handle<typeof AgentRuntime>["instance"]>,
  "harness" | "workspacePath"
> & {
  model: NonNullable<ReturnType<ModelRuntime["findAvailableModel"]>>;
  modelCollection: ModelRuntime["modelCollection"];
  contextReader: ReturnType<typeof createContextReader>;
};

export function defineWorkflow<T extends WorkflowInstance>(
  create: (dependencies: WorkflowDependencies) => T,
  { self, modelRef, contextReader }: WorkflowContext,
) {
  const models = self.get(AgentModels, {});
  const runtime = self.get(AgentRuntime, {});
  return resource({
    rev: 1,
    deps: [models, runtime],
    open: () => {
      const { findAvailableModel, modelCollection } =
        getServiceInstance(models);
      const model = findAvailableModel(modelRef);
      if (!model) return { run: undefined };
      const { harness, workspacePath } = getServiceInstance(runtime);
      return create({
        model,
        modelCollection,
        harness,
        workspacePath,
        contextReader,
      });
    },
    close: async (workflow) => {
      if ("close" in workflow) await workflow.close?.();
    },
  });
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
  const [cause, result] = await tryit(async () => {
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
  })();
  if (!cause) return result;
  if (signal.aborted) throw new AppError("request_cancelled", { cause });
  if (cause instanceof AppError) throw cause;
  throw new AppError("agent_execution_failed", { cause });
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
