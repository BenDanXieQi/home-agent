import { fileURLToPath } from "node:url";
import {
  scanModules,
  validateModuleNames,
  writeGeneratedFile,
} from "./modules";

const workflowDirectory = fileURLToPath(
  new URL("../../src/workflows/", import.meta.url),
);
const registryPath = `${workflowDirectory}registry.generated.ts`;
const contractsPath = `${workflowDirectory}contracts.generated.ts`;

export async function generateWorkflows() {
  const files = scanModules(workflowDirectory, "*/workflow.ts");
  const names = files.map((file) => file.slice(0, -"/workflow.ts".length));
  validateModuleNames(names);

  const contracts = `import { z } from "zod";
${names.map((name, index) => `import { contract as contract${index} } from "./${name}/workflow";`).join("\n")}

export const agentWorkflowInputSchema = z.discriminatedUnion("workflow", [
${names.map((name, index) => `  z.strictObject({ workflow: z.literal("${name}"), input: contract${index}.input }),`).join("\n")}
]);

export const agentWorkflowStreamContracts = {
${names
  .map(
    (name, index) => `  "${name}": {
    progress: z.strictObject({ workflow: z.literal("${name}"), progress: contract${index}.progress }),
    result: z.strictObject({ workflow: z.literal("${name}"), result: contract${index}.result }),
  },`,
  )
  .join("\n")}
};

export const agentWorkflowStreamContract = {
  progress: z.discriminatedUnion("workflow", [
${names.map((name) => `  agentWorkflowStreamContracts["${name}"].progress,`).join("\n")}
  ]),

  result: z.discriminatedUnion("workflow", [
${names.map((name) => `  agentWorkflowStreamContracts["${name}"].result,`).join("\n")}
  ]),
};
`;

  const registry = `import { z } from "zod";
import { resource, type Self } from "@earendil-works/chord";
import type { Config } from "../config";
import type { agentWorkflowInputSchema, agentWorkflowStreamContract } from "./contracts.generated";
import { runWorkflow, type WorkflowDependencies, type WorkflowInstance, type WorkflowRegistry } from "./definition";
import { observeWorkflowExecution } from "./observation";
${names
  .map(
    (name, index) =>
      `import { contract as contract${index}, createWorkflow as createWorkflow${index}, extensions as extensions${index}, modelConfiguration as modelConfiguration${index}, observation as observation${index} } from "./${name}/workflow";`,
  )
  .join("\n")}

export const workflowConfigurationSchema = z.object({
${names.map((_name, index) => `  [modelConfiguration${index}.key]: modelConfiguration${index}.schema,`).join("\n")}
});

export function configureWorkflowRegistry(config: Config) {
${names.map((_name, index) => `  const modelRef${index} = config[modelConfiguration${index}.key] ?? config.AGENT_MODEL;`).join("\n")}
  return {
    modelRefs: [${names.map((_name, index) => `modelRef${index}`).join(", ")}],
    extensions: [${names.map((_name, index) => `...extensions${index}`).join(", ")}],
    createRegistry(self: Self, contextReader: WorkflowDependencies["contextReader"]) {
  const workflows = self.resources({
${names.map((name, index) => `    "${name}": createWorkflow${index}({ self, modelRef: modelRef${index}, contextReader }),`).join("\n")}
  });
  return self.resources({
    registry: resource({
      rev: 1,
      deps: Object.values(workflows),
      open: () => {
        const registry = {
${names.map((name) => `          "${name}": workflows["${name}"].value,`).join("\n")}
        } satisfies WorkflowRegistry;
  const instances: WorkflowInstance[] = Object.values(registry);
  return {
    execute: async (input: z.output<typeof agentWorkflowInputSchema>, signal: AbortSignal, receive?: (progress: z.output<typeof agentWorkflowStreamContract.progress>) => Promise<void>) => {
      switch (input.workflow) {
${names
  .map(
    (name, index) => `        case "${name}":
          return {
            workflow: input.workflow,
            result: await observeWorkflowExecution("${name}", observation${index}, input.input, () =>
              runWorkflow(registry["${name}"].run, contract${index}, input.input, signal, receive ? async (progress) => {
                await receive({ workflow: input.workflow, progress });
              } : undefined),
            ),
          };`,
  )
  .join("\n")}
      }
    },
    reset: async () => {
      const results = await Promise.allSettled(instances.map(async (instance) => {
        await instance.reset?.();
      }));
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Workflow reset failed");
    },
  };
      },
    }),
  }).registry;
    },
  };
}
`;
  await writeGeneratedFile(contractsPath, contracts);
  await writeGeneratedFile(registryPath, registry);
}

if (import.meta.main) await generateWorkflows();
