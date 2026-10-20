import { local, opaque, type Host } from "@earendil-works/chord";
import { Type } from "typebox";
import { configureWorkflowRegistry } from "./registry.generated";
import type { WorkflowDependencies } from "./definition";

export function configureWorkflows(
  config: Parameters<typeof configureWorkflowRegistry>[0],
) {
  const configuration = configureWorkflowRegistry(config);
  const Workflows = local("home.agent.workflows", {
    version: 1,
    input: Type.Object({}),
    members: {
      instance: opaque<ReturnType<typeof createWorkflows>>(
        "home.agent.workflows@1",
      ),
    },
  });
  return {
    modelRefs: configuration.modelRefs,
    register(host: Host, contextReader: WorkflowDependencies["contextReader"]) {
      host.serve(
        Workflows,
        (_input, _principal, self) => {
          const registry = configuration.createRegistry(self, contextReader);
          return { instance: createWorkflows(registry) };
        },
        { eager: true },
      );
      return host.get(Workflows, {});
    },
  };
}

function createWorkflows(
  workflows: ReturnType<
    ReturnType<typeof configureWorkflowRegistry>["createRegistry"]
  >,
) {
  return {
    run: (...args: Parameters<typeof workflows.value.execute>) =>
      workflows.value.execute(...args),
    reset: () => workflows.value.reset(),
  };
}
