import { z } from "zod";

const optionalText = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);
const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
  );
}, "Use an HTTP(S) URL without embedded credentials");

const environment = z.object({
  DATABASE_URL: optionalText.pipe(
    z
      .url()
      .refine(
        (value) =>
          ["postgres:", "postgresql:"].includes(new URL(value).protocol),
        "Use a PostgreSQL connection URL",
      )
      .optional(),
  ),
  AGENT_DATABASE_URL: optionalText.pipe(
    z
      .url()
      .refine(
        (value) =>
          ["postgres:", "postgresql:"].includes(new URL(value).protocol),
        "Use a PostgreSQL connection URL",
      )
      .optional(),
  ),
  AGENT_HOST: z.string().min(1).default("127.0.0.1"),
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(1811),
  AGENT_MODEL: optionalText,
  OPENAI_API_KEY: optionalText,
  OPENAI_BASE_URL: optionalText.pipe(httpUrl.optional()),
  AGENT_RUN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(120_000),
});

export type Config = z.infer<typeof environment>;

export function loadConfig(env: Record<string, string | undefined> = Bun.env) {
  const result = environment.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  return result.data;
}
