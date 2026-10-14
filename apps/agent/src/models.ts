import { hasApi, type CreateProviderOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Config } from "./config";

type ModelConfig = Pick<
  Config,
  | "AGENT_PROVIDER"
  | "AGENT_MODEL"
  | "AGENT_MODEL_METADATA"
  | "AGENT_THINKING"
  | "OPENAI_API_KEY"
  | "OPENAI_BASE_URL"
>;

function configuredModel(config: ModelConfig, id: string) {
  const metadata =
    id === config.AGENT_MODEL ? config.AGENT_MODEL_METADATA : undefined;
  const catalogModel = builtinModels().getModel(config.AGENT_PROVIDER, id);
  if (
    catalogModel &&
    !hasApi(catalogModel, "openai-completions") &&
    !hasApi(catalogModel, "openai-responses")
  )
    throw new Error(
      "The configured model must use openai-completions or openai-responses",
    );
  if (catalogModel && metadata && metadata.api !== catalogModel.api)
    throw new Error(
      "AGENT_MODEL_METADATA.api must match the catalog model; configure a custom provider for a different protocol",
    );
  const definition = metadata ?? catalogModel;
  if (!definition)
    throw new Error(
      "Model is not in the AGENT_PROVIDER catalog; only AGENT_MODEL can use explicit AGENT_MODEL_METADATA",
    );
  const baseUrl = config.OPENAI_BASE_URL ?? catalogModel?.baseUrl;
  if (!baseUrl) throw new Error("Set OPENAI_BASE_URL for a custom model");
  return {
    ...catalogModel,
    ...definition,
    compat: { ...catalogModel?.compat, ...definition.compat },
    id,
    name: catalogModel?.name ?? id,
    provider: config.AGENT_PROVIDER,
    baseUrl,
    ...(config.AGENT_THINKING
      ? {
          samplingParams: {
            ...catalogModel?.samplingParams,
            thinking: { type: config.AGENT_THINKING },
          },
        }
      : {}),
  };
}

export function modelProviderSettings(
  config: ModelConfig,
  ids: readonly string[],
) {
  if (!config.OPENAI_API_KEY || !config.AGENT_MODEL) return undefined;
  const apiKey = config.OPENAI_API_KEY;
  const models = [...new Set(ids)].map((id) => configuredModel(config, id));
  return {
    id: config.AGENT_PROVIDER,
    auth: {
      apiKey: {
        name: "OpenAI compatible API key",
        resolve: async () => ({ auth: { apiKey }, source: "OPENAI_API_KEY" }),
      },
    },
    models,
    api: {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  } satisfies CreateProviderOptions<(typeof models)[number]["api"]>;
}
