import { z } from "zod";
import { tryit } from "radash";

import {
  modelRefSchema,
  optionalModelRefSchema,
  blankAsUndefinedTextSchema,
} from "./models";
import { workflowConfigurationSchema } from "./workflows/registry.generated";

const modelRefsJsonSchema = z
  .string()
  .transform((value, ctx) => {
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
  })
  .pipe(z.array(modelRefSchema).min(1));

export const agentConfigurationSchema = z.object({
  ...workflowConfigurationSchema.shape,
  AGENT_MODEL: optionalModelRefSchema,
  AGENT_SUBAGENT_MODELS: blankAsUndefinedTextSchema.pipe(
    modelRefsJsonSchema.optional(),
  ),
});

export function loadConfig(env: Record<string, string | undefined> = Bun.env) {
  const result = agentConfigurationSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid agent configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );

  return result.data;
}

export type Config = ReturnType<typeof loadConfig>;
