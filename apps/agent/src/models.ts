import {
  createModels,
  createProvider,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { observeProvider } from "@home-agent/observability";
import type { ModelRef } from "@earendil-works/pi-durable";
import { compact, uniq } from "es-toolkit";
import { z } from "zod";
import { withMediaProvider } from "./media-analysis/analysis";

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
  llamaCpp,
  signal,
}: {
  modelRefs: readonly ModelRef[];
  llamaCpp?:
    | {
        baseUrl: string;
        apiKey?: string | undefined;
      }
    | undefined;
  signal: AbortSignal;
}) {
  signal.throwIfAborted();

  const modelCollection = createModels();
  const builtinModelCollection = builtinModels();
  const providerIds = uniq(modelRefs.map(({ provider }) => provider));
  for (const providerId of providerIds) {
    if (providerId === "llamacpp") {
      if (!llamaCpp)
        throw new Error("LLAMA_CPP_BASE_URL is required for llamacpp models");

      const response = await fetch(
        `${llamaCpp.baseUrl.replace(/\/$/, "")}/models`,
        {
          headers: {
            Authorization: `Bearer ${llamaCpp.apiKey ?? "llama.cpp"}`,
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        },
      );
      if (!response.ok)
        throw new Error(
          `llama.cpp model discovery failed: HTTP ${response.status}`,
        );

      const catalog = z
        .object({
          data: z.array(
            z.object({
              id: z.string(),
              meta: z.object({ n_ctx: z.number().int().positive() }),
            }),
          ),
        })
        .parse(await response.json());
      const serverModels = new Map(
        catalog.data.map((model) => [model.id, model]),
      );

      const llamaCppProvider = createProvider({
        id: providerId,
        name: "llama.cpp",
        baseUrl: llamaCpp.baseUrl,
        auth: {
          apiKey: {
            name: "llama.cpp API key",
            resolve: async () => ({
              auth: { apiKey: llamaCpp.apiKey ?? "llama.cpp" },
            }),
          },
        },
        models: uniq(
          modelRefs
            .filter(({ provider }) => provider === providerId)
            .map(({ modelId }) => modelId),
        ).map((modelId) => {
          const serverModel = serverModels.get(modelId);
          if (!serverModel)
            throw new Error(
              `Configured model is unavailable in llama.cpp: ${modelId}`,
            );

          return {
            id: modelId,
            name: modelId,
            api: "openai-completions",
            provider: providerId,
            baseUrl: llamaCpp.baseUrl,
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: serverModel.meta.n_ctx,
            maxTokens: 8192,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              maxTokensField: "max_tokens",
            },
          } satisfies Model<"openai-completions">;
        }),
        api: openAICompletionsApi(),
      });
      modelCollection.setProvider(
        withMediaProvider(observeProvider(llamaCppProvider)),
      );
      continue;
    }

    const provider = builtinModelCollection.getProvider(providerId);

    if (!provider)
      throw new Error(`Configured provider is not registered: ${providerId}`);

    modelCollection.setProvider(withMediaProvider(observeProvider(provider)));
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
      compact(requestedModelRefs.map(findAvailableModel)).map((model) => [
        modelKey(model.provider, model.id),
        model,
      ]),
    );

  return { modelCollection, findAvailableModel, selectAvailableModels };
}
