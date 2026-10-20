import { createModels, type Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  GenerationTask,
  hook,
  type RegistryReader,
  ToolTask,
  wrapTool,
} from "@earendil-works/pi-durable";
import {
  prepareDurableGeneration,
  prepareDurableTool,
  withDurableModelTrace,
  withDurableToolTrace,
} from "./durable";
import { observeDurableRegistry } from "./durable-compaction";

export function createObservedHarnessOptions({
  sourceModelCollection,
  extensions,
}: {
  sourceModelCollection: Models;
  extensions: readonly Parameters<
    ReturnType<typeof createRegistry>["install"]
  >[0][];
}) {
  const registry = createRegistry();

  for (const extension of extensions) {
    registry.install(extension);
  }

  const observationExtension = createDurableTracingExtension(registry);
  registry.install(observationExtension);

  return {
    models: createObservedModelCollection(sourceModelCollection),
    registry: observeDurableRegistry(registry),
    observationExtension,
    extensionRegistry: registry,
  };
}

function createObservedModelCollection(sourceModelCollection: Models) {
  const observedModelCollection = createModels();

  for (const provider of sourceModelCollection.getProviders()) {
    observedModelCollection.setProvider({
      ...provider,
      streamSimple: (model, transcript, options) =>
        withDurableModelTrace(options?.signal, transcript, () =>
          provider.streamSimple(model, transcript, options),
        ),
    });
  }

  return observedModelCollection;
}

function createDurableTracingExtension(registry: RegistryReader) {
  return defineExtension({
    name: "execution-observations",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          await prepareDurableGeneration(api, context);
        },
      }),
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          await prepareDurableTool(call, api, context);
        },
      }),
    ],
    wraps: registry
      .snapshot()
      .tools()
      .map(({ tool }) =>
        wrapTool(tool, (original) => ({
          ...original,
          execute: (args, api, context) =>
            withDurableToolTrace(api, () =>
              original.execute(args, api, context),
            ),
        })),
      ),
  });
}
