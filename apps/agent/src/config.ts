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
const modelJson = z.string().transform((value, ctx) => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Use valid model configuration JSON",
    });
    return z.NEVER;
  }
});
const modelEnvironment = z.object({
  AGENT_PROVIDER: optionalText.pipe(z.string().min(1).default("openai")),
  AGENT_MODEL: optionalText,
  AGENT_AUTOMATION_MODEL: optionalText,
  AGENT_SPEECH_MODEL: optionalText,
  AGENT_SUBAGENT_MODELS: optionalText.pipe(
    modelJson.pipe(z.array(z.string().min(1)).min(1)).optional(),
  ),
  AGENT_MODEL_METADATA: optionalText.pipe(
    modelJson.pipe(modelMetadata).optional(),
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

const environment = modelEnvironment.extend({
  BACKEND_URL: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:3000"),
  AGENT_HOST: z.string().min(1).default("127.0.0.1"),
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(1811),
  AGENT_RUN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3600000)
    .default(120000),
  AGENT_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(256)
    .max(32768)
    .default(4096),
});
export function loadConfig(env: Record<string, string | undefined> = Bun.env) {
  const result = environment.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid agent configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return result.data;
}
export type Config = ReturnType<typeof loadConfig>;
