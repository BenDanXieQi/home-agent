import { local, opaque, resource, type Host } from "@earendil-works/chord";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { observeProvider } from "@home-agent/observability";
import type { ModelRef } from "@earendil-works/pi-durable";
import { sift, unique } from "radash";
import { z } from "zod";

export const blankAsUndefinedTextSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

export const modelRefSchema = z
  .string()
  .regex(/^[^/\s]+\/\S+$/, "Use provider/modelId")
  .transform((value) => {
    const separatorIndex = value.indexOf("/");
    return {
      provider: value.slice(0, separatorIndex),
      modelId: value.slice(separatorIndex + 1),
    };
  });

export const optionalModelRefSchema = blankAsUndefinedTextSchema.pipe(
  modelRefSchema.optional(),
);

const modelKey = (provider: string, modelId: string) =>
  `${provider}/${modelId}`;

export async function initializeModelRuntime({
  modelRefs,
  signal,
}: {
  modelRefs: readonly ModelRef[];
  signal: AbortSignal;
}) {
  signal.throwIfAborted();

  const modelCollection = createModels();
  const builtinModelCollection = builtinModels();
  const providerIds = unique(modelRefs.map(({ provider }) => provider));
  for (const providerId of providerIds) {
    const provider = builtinModelCollection.getProvider(providerId);

    if (!provider)
      throw new Error(`Configured provider is not registered: ${providerId}`);

    modelCollection.setProvider(observeProvider(provider));
  }

  for (const { provider, modelId } of modelRefs) {
    if (!modelCollection.getModel(provider, modelId))
      throw new Error(
        `Configured model is not in the provider catalog: ${modelKey(provider, modelId)}`,
      );
  }

  const availableModels = modelRefs.length
    ? await modelCollection.getAvailable(undefined, {
        signal,
      })
    : [];
  const availableModelsByKey = new Map(
    availableModels.map((model) => [modelKey(model.provider, model.id), model]),
  );

  const findAvailableModel = (modelRef: ModelRef | undefined) =>
    modelRef &&
    availableModelsByKey.get(modelKey(modelRef.provider, modelRef.modelId));

  const selectAvailableModels = (
    requestedModelRefs: readonly (ModelRef | undefined)[],
  ) =>
    new Map(
      sift(requestedModelRefs.map(findAvailableModel)).map((model) => [
        modelKey(model.provider, model.id),
        model,
      ]),
    );

  return { modelCollection, findAvailableModel, selectAvailableModels };
}

export const AgentModels = local("home.agent.models", {
  version: 1,
  input: Type.Object({}),
  members: {
    instance: opaque<Awaited<ReturnType<typeof initializeModelRuntime>>>(
      "home.agent.models@1",
    ),
  },
});

export function registerAgentModels(
  host: Host,
  options: Parameters<typeof initializeModelRuntime>[0],
) {
  host.serve(
    AgentModels,
    (_input, _principal, self) => {
      const resources = self.resources({
        models: resource({
          rev: 1,
          open: ({ signal }) =>
            initializeModelRuntime({
              ...options,
              signal: AbortSignal.any([signal, options.signal]),
            }),
        }),
      });

      return { instance: self.expose(resources.models) };
    },
    { eager: true },
  );
}
