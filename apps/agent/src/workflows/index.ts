import { configureWorkflowRegistry } from "./registry.generated";

export function configureWorkflows(
  config: Parameters<typeof configureWorkflowRegistry>[0],
) {
  const configuration = configureWorkflowRegistry(config);
  return {
    modelRefs: configuration.modelRefs,
    extensions: configuration.extensions,
    async create(
      dependencies: Parameters<typeof configuration.createRegistry>[0],
    ) {
      const workflows = await configuration.createRegistry(dependencies);
      return {
        run: (
          ...[input, signal, receive]: Parameters<typeof workflows.execute>
        ) =>
          dependencies.contextReader.readCurrent(signal, (currentSignal) =>
            workflows.execute(input, currentSignal, receive),
          ),
        reset: workflows.reset,
        close: workflows.close,
      };
    },
  };
}
