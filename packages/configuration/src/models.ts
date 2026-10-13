import { hasApi, type CreateProviderOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";

const optionalText = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);
const modelMetadata = z.strictObject({
  api: z.enum(["openai-completions", "openai-responses"]),
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])).min(1),
  contextWindow: z.int().positive(),
  maxTokens: z.int().positive(),
  cost: z.strictObject({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
  }),
  compat: z.strictObject({
    supportsStrictMode: z.boolean(),
    supportsDeveloperRole: z.boolean().exactOptional(),
    supportsReasoningEffort: z.boolean().exactOptional(),
    supportsStore: z.boolean().exactOptional(),
    maxTokensField: z
      .enum(["max_tokens", "max_completion_tokens"])
      .exactOptional(),
    requiresReasoningContentOnAssistantMessages: z.boolean().exactOptional(),
    thinkingFormat: z
      .enum(["openai", "deepseek", "zai", "together", "ant-ling", "openrouter"])
      .exactOptional(),
  }),
});
const metadataJson = z.string().transform((value, ctx) => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Use a JSON model metadata object",
    });
    return z.NEVER;
  }
});
export const modelEnvironment = z.object({
  AGENT_PROVIDER: optionalText.pipe(z.string().min(1).default("openai")),
  AGENT_MODEL: optionalText,
  AGENT_MODEL_METADATA: optionalText.pipe(
    metadataJson.pipe(modelMetadata).optional(),
  ),
  AGENT_THINKING: optionalText.pipe(z.enum(["enabled", "disabled"]).optional()),
  OPENAI_API_KEY: optionalText,
  OPENAI_BASE_URL: optionalText.pipe(
    z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }, "Use an HTTP(S) URL without credentials")
      .optional(),
  ),
});

export function loadModelConfig(
  env: Record<string, string | undefined> = Bun.env,
) {
  const result = modelEnvironment.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid model configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return result.data;
}

export function modelProviderSettings(
  config: z.infer<typeof modelEnvironment>,
) {
  if (!config.OPENAI_API_KEY || !config.AGENT_MODEL) return undefined;
  const apiKey = config.OPENAI_API_KEY;
  const catalogModel = builtinModels().getModel(
    config.AGENT_PROVIDER,
    config.AGENT_MODEL,
  );
  if (
    catalogModel &&
    !hasApi(catalogModel, "openai-completions") &&
    !hasApi(catalogModel, "openai-responses")
  )
    throw new Error(
      "The configured model must use openai-completions or openai-responses",
    );
  if (
    catalogModel &&
    config.AGENT_MODEL_METADATA &&
    config.AGENT_MODEL_METADATA.api !== catalogModel.api
  )
    throw new Error(
      "AGENT_MODEL_METADATA.api must match the catalog model; configure a custom provider for a different protocol",
    );
  const definition = config.AGENT_MODEL_METADATA ?? catalogModel;
  if (!definition)
    throw new Error(
      "AGENT_MODEL is not in the AGENT_PROVIDER catalog; set verified AGENT_MODEL_METADATA and OPENAI_BASE_URL",
    );
  const baseUrl = config.OPENAI_BASE_URL ?? catalogModel?.baseUrl;
  if (!baseUrl) throw new Error("Set OPENAI_BASE_URL for a custom model");
  const model = {
    ...catalogModel,
    ...definition,
    compat: { ...catalogModel?.compat, ...definition.compat },
    id: config.AGENT_MODEL,
    name: catalogModel?.name ?? config.AGENT_MODEL,
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
  return {
    id: model.provider,
    baseUrl: model.baseUrl,
    auth: {
      apiKey: {
        name: "OpenAI compatible API key",
        resolve: async () => ({ auth: { apiKey }, source: "OPENAI_API_KEY" }),
      },
    },
    models: [model] as const,
    api:
      model.api === "openai-completions"
        ? openAICompletionsApi()
        : openAIResponsesApi(),
  } satisfies CreateProviderOptions<typeof model.api>;
}

export type ConfiguredModel = NonNullable<
  ReturnType<typeof modelProviderSettings>
>["models"][number];
