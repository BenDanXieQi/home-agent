import { z } from "zod";
import { agentConfigurationSchema } from "@home-agent/agent/config";

const environmentSchema = agentConfigurationSchema.extend({
  BACKEND_URL: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:3000"),
  AGENT_HOST: z.string().min(1).default("127.0.0.1"),
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(1811),
  AGENT_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(2147483647)
    .default(10000),
});

export function loadConfig(env: Record<string, string | undefined> = Bun.env) {
  const result = environmentSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid agent host configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return result.data;
}
