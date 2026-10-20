import { z } from "zod";
import { resource, type Self } from "@earendil-works/chord";
import type { Config } from "../config";
import type {
  agentWorkflowInputSchema,
  agentWorkflowStreamContract,
} from "./contracts.generated";
import {
  runWorkflow,
  type WorkflowDependencies,
  type WorkflowInstance,
  type WorkflowRegistry,
} from "./definition";
import { observeWorkflowExecution } from "./observation";
import {
  contract as contract0,
  createWorkflow as createWorkflow0,
  extensions as extensions0,
  modelConfiguration as modelConfiguration0,
  observation as observation0,
} from "./automation-generation/workflow";
import {
  contract as contract1,
  createWorkflow as createWorkflow1,
  extensions as extensions1,
  modelConfiguration as modelConfiguration1,
  observation as observation1,
} from "./spatial-planning/workflow";
import {
  contract as contract2,
  createWorkflow as createWorkflow2,
  extensions as extensions2,
  modelConfiguration as modelConfiguration2,
  observation as observation2,
} from "./speech-interpretation/workflow";

export const workflowConfigurationSchema = z.object({
  [modelConfiguration0.key]: modelConfiguration0.schema,
  [modelConfiguration1.key]: modelConfiguration1.schema,
  [modelConfiguration2.key]: modelConfiguration2.schema,
});

export function configureWorkflowRegistry(config: Config) {
  const modelRef0 = config[modelConfiguration0.key] ?? config.AGENT_MODEL;
  const modelRef1 = config[modelConfiguration1.key] ?? config.AGENT_MODEL;
  const modelRef2 = config[modelConfiguration2.key] ?? config.AGENT_MODEL;
  return {
    modelRefs: [modelRef0, modelRef1, modelRef2],
    extensions: [...extensions0, ...extensions1, ...extensions2],
    createRegistry(
      self: Self,
      contextReader: WorkflowDependencies["contextReader"],
    ) {
      const workflows = self.resources({
        "automation-generation": createWorkflow0({
          self,
          modelRef: modelRef0,
          contextReader,
        }),
        "spatial-planning": createWorkflow1({
          self,
          modelRef: modelRef1,
          contextReader,
        }),
        "speech-interpretation": createWorkflow2({
          self,
          modelRef: modelRef2,
          contextReader,
        }),
      });
      return self.resources({
        registry: resource({
          rev: 1,
          deps: Object.values(workflows),
          open: () => {
            const registry = {
              "automation-generation": workflows["automation-generation"].value,
              "spatial-planning": workflows["spatial-planning"].value,
              "speech-interpretation": workflows["speech-interpretation"].value,
            } satisfies WorkflowRegistry;
            const instances: WorkflowInstance[] = Object.values(registry);
            return {
              execute: async (
                input: z.output<typeof agentWorkflowInputSchema>,
                signal: AbortSignal,
                receive?: (
                  progress: z.output<
                    typeof agentWorkflowStreamContract.progress
                  >,
                ) => Promise<void>,
              ) => {
                switch (input.workflow) {
                  case "automation-generation":
                    return {
                      workflow: input.workflow,
                      result: await observeWorkflowExecution(
                        "automation-generation",
                        observation0,
                        input.input,
                        () =>
                          runWorkflow(
                            registry["automation-generation"].run,
                            contract0,
                            input.input,
                            signal,
                            receive
                              ? async (progress) => {
                                  await receive({
                                    workflow: input.workflow,
                                    progress,
                                  });
                                }
                              : undefined,
                          ),
                      ),
                    };
                  case "spatial-planning":
                    return {
                      workflow: input.workflow,
                      result: await observeWorkflowExecution(
                        "spatial-planning",
                        observation1,
                        input.input,
                        () =>
                          runWorkflow(
                            registry["spatial-planning"].run,
                            contract1,
                            input.input,
                            signal,
                            receive
                              ? async (progress) => {
                                  await receive({
                                    workflow: input.workflow,
                                    progress,
                                  });
                                }
                              : undefined,
                          ),
                      ),
                    };
                  case "speech-interpretation":
                    return {
                      workflow: input.workflow,
                      result: await observeWorkflowExecution(
                        "speech-interpretation",
                        observation2,
                        input.input,
                        () =>
                          runWorkflow(
                            registry["speech-interpretation"].run,
                            contract2,
                            input.input,
                            signal,
                            receive
                              ? async (progress) => {
                                  await receive({
                                    workflow: input.workflow,
                                    progress,
                                  });
                                }
                              : undefined,
                          ),
                      ),
                    };
                }
              },
              reset: async () => {
                const results = await Promise.allSettled(
                  instances.map(async (instance) => {
                    await instance.reset?.();
                  }),
                );
                const errors = results.flatMap((result) =>
                  result.status === "rejected" ? [result.reason] : [],
                );
                if (errors.length)
                  throw new AggregateError(errors, "Workflow reset failed");
              },
            };
          },
        }),
      }).registry;
    },
  };
}
