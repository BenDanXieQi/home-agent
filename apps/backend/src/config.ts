import { z } from "zod";

const environment = z.object({
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
  AGENT_BASE_URL: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    }, "Use an HTTP(S) URL without embedded credentials")
    .default("http://127.0.0.1:1811"),
  BACKEND_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(130_000),
});

export type Config = z.infer<typeof environment>;

export function loadConfig(
  env: Record<string, string | undefined> = Bun.env,
): Config {
  const result = environment.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  return result.data;
}
