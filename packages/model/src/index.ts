import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import { z } from "zod";

const optionalText = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);
export const modelEnvironment = z.object({
  AGENT_MODEL: optionalText,
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
export type ModelConfig = z.infer<typeof modelEnvironment>;
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
export function createModel(
  config: ModelConfig,
  options: Pick<
    ChatOpenAIFields,
    "streaming" | "streamUsage" | "maxRetries" | "timeout" | "maxTokens"
  >,
) {
  if (!config.OPENAI_API_KEY || !config.AGENT_MODEL) return undefined;
  return new ChatOpenAI({
    ...options,
    model: config.AGENT_MODEL,
    apiKey: config.OPENAI_API_KEY,
    ...(config.AGENT_THINKING
      ? { modelKwargs: { thinking: { type: config.AGENT_THINKING } } }
      : {}),
    ...(config.OPENAI_BASE_URL
      ? { configuration: { baseURL: config.OPENAI_BASE_URL } }
      : {}),
  });
}
