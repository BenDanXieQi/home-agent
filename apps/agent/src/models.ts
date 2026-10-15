import { createModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { observeProvider } from "@home-agent/observability";
import type { ModelRef } from "@earendil-works/pi-durable";
import { sift, unique } from "radash";
import { z } from "zod";

export const optionalTextSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

export const modelReferenceSchema = z
  .string()
  .regex(/^[^/\s]+\/\S+$/, "Use provider/modelId")
  .transform((value) => {
    const separator = value.indexOf("/");
    return {
      provider: value.slice(0, separator),
      modelId: value.slice(separator + 1),
    };
  });

export const optionalModelReferenceSchema = optionalTextSchema.pipe(
  modelReferenceSchema.optional(),
);

const modelKey = (provider: string, modelId: string) =>
  `${provider}/${modelId}`;

export async function initializeModels({
  modelRefs,
  timeoutMs,
  signal,
}: {
  modelRefs: readonly ModelRef[];
  timeoutMs: number;
  signal: AbortSignal;
}) {
  signal.throwIfAborted();
  const models = createModels();
  const builtinCatalog = builtinModels();
  const providerIds = unique(modelRefs.map(({ provider }) => provider));
  for (const providerId of providerIds) {
    const provider = builtinCatalog.getProvider(providerId);

    if (!provider)
      throw new Error(`Configured provider is not registered: ${providerId}`);

    models.setProvider(observeProvider(provider));
  }

  for (const { provider, modelId } of modelRefs) {
    if (!models.getModel(provider, modelId))
      throw new Error(
        `Configured model is not in the provider catalog: ${modelKey(provider, modelId)}`,
      );
  }

  const availableModels = modelRefs.length
    ? await models.getAvailable(undefined, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      })
    : [];
  const availableModelsByKey = new Map(
    availableModels.map((model) => [modelKey(model.provider, model.id), model]),
  );

  const resolve = (modelRef: ModelRef | undefined) =>
    modelRef &&
    availableModelsByKey.get(modelKey(modelRef.provider, modelRef.modelId));

  const select = (refs: readonly (ModelRef | undefined)[]) =>
    new Map(
      sift(refs.map(resolve)).map((model) => [
        modelKey(model.provider, model.id),
        model,
      ]),
    );

  return { models, resolve, select };
}
