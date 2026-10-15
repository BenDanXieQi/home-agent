import { z } from "zod";
import { tryit } from "radash";

import {
  modelReferenceSchema,
  optionalModelReferenceSchema,
  optionalTextSchema,
} from "./models";
import { workflowConfigurationSchema } from "./workflows/registry.generated";

const jsonValueSchema = z.string().transform((value, ctx) => {
  const [error, parsed] = tryit(() => {
    const json: unknown = JSON.parse(value);
    return json;
  })();
  if (!error) return parsed;
  ctx.addIssue({
    code: "custom",
    message: "Use valid model configuration JSON",
  });
  return z.NEVER;
});
const positiveIntegerSchema = z.coerce.number().int().positive();
const environmentSchema = z.object({
  ...workflowConfigurationSchema.shape,
  AGENT_MODEL: optionalModelReferenceSchema,
  AGENT_SUBAGENT_MODELS: optionalTextSchema.pipe(
    jsonValueSchema.pipe(z.array(modelReferenceSchema).min(1)).optional(),
  ),
  BACKEND_URL: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:3000"),
  AGENT_HOST: z.string().min(1).default("127.0.0.1"),
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(1811),
  AGENT_RUN_TIMEOUT_MS: positiveIntegerSchema.default(120000),
  AGENT_SHUTDOWN_TIMEOUT_MS: positiveIntegerSchema
    .max(2147483647)
    .default(10000),
  AGENT_MAX_OUTPUT_TOKENS: positiveIntegerSchema.default(4096),
});
export function loadConfig(env: Record<string, string | undefined> = Bun.env) {
  const result = environmentSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid agent configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return result.data;
}
export type Config = ReturnType<typeof loadConfig>;
