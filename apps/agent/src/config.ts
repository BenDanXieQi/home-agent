import { modelEnvironment } from "@home-agent/model";
import { z } from "zod";
const environment = modelEnvironment.extend({
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
