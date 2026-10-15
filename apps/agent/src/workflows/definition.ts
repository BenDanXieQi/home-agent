import type { z } from "zod";
import type { agentContextScopeSchema } from "@home-agent/api/agent-context";
import type {
  agentWorkflowInputSchema,
  agentWorkflowResultSchema,
} from "./contracts";
import type { initializeModels } from "../models";
import type { completeStructuredOutput } from "./structured-output";

export type WorkflowContext = {
  modelCatalog: Awaited<ReturnType<typeof initializeModels>>;
  modelRef: Parameters<WorkflowContext["modelCatalog"]["resolve"]>[0];
  budget: Omit<Parameters<typeof completeStructuredOutput>[3], "signal">;
};

type WorkflowInput = z.output<typeof agentWorkflowInputSchema>;
type WorkflowResult = z.output<typeof agentWorkflowResultSchema>;

export type WorkflowInstance = {
  run: unknown;
  retainScope?:
    | ((
        scope: z.output<typeof agentContextScopeSchema> | null,
      ) => Promise<void>)
    | undefined;
  close?: (() => Promise<void>) | undefined;
};

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

export async function closeWorkflows(workflows: WorkflowInstance[]) {
  const results = await Promise.allSettled(
    workflows.map(async (workflow) => {
      await workflow.close?.();
    }),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, "Workflow cleanup failed");
}
