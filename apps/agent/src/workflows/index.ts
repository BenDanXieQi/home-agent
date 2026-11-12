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
    extensions: configuration.extensions,
    register(
      host: Host,
      contextReader: WorkflowDependencies["contextReader"],
      signal: AbortSignal,
    ) {
      host.serve(
        Workflows,
        (_input, _principal, self) => {
          const registry = configuration.createRegistry(self, contextReader);
          return { instance: createWorkflows(registry, contextReader) };
        },
        { lifetime: "host" },
      );
      return host.get(Workflows, {}, { signal });
    },
  };
}

function createWorkflows(
  workflows: ReturnType<
    ReturnType<typeof configureWorkflowRegistry>["createRegistry"]
  >,
  contextReader: WorkflowDependencies["contextReader"],
) {
  return {
    run: (
      ...[input, signal, receive]: Parameters<typeof workflows.value.execute>
    ) =>
      contextReader.readCurrent(signal, (currentSignal) =>
        workflows.value.execute(input, currentSignal, receive),
      ),
    reset: () => workflows.value.reset(),
  };
}
