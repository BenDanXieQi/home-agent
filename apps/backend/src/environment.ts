import { z } from "zod";

const environmentSchema = z.object({
  CREDENTIAL_KEY_FILE: z.string().trim().min(1).optional(),
  DATABASE_URL: z
    .url()
    .refine(
      (value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol),
      "Use a PostgreSQL connection URL",
    )
    .optional(),
  BACKEND_HOST: z.string().trim().min(1).default("127.0.0.1"),
  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BACKEND_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
  BACKEND_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(130_000),
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(
  env: Record<string, string | undefined> = Bun.env,
) {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  return result.data;
}
