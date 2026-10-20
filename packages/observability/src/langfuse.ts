import { z } from "zod";

const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);
const endpoint = optionalText.pipe(
  z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    })
    .optional(),
);

export const langfuseConfigurationSchema = z.object({
  COMPOSE_PROFILES: optionalText,
  LANGFUSE_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LANGFUSE_BASE_URL: endpoint,
  LANGFUSE_PUBLIC_KEY: optionalText,
  LANGFUSE_SECRET_KEY: optionalText,
});

export function langfuseConnection(
  config: z.output<typeof langfuseConfigurationSchema>,
) {
  const localLangfuse = config.COMPOSE_PROFILES?.split(",").some(
    (profile) => profile.trim() === "langfuse",
  );
  const baseUrl = (
    config.LANGFUSE_BASE_URL ??
    (localLangfuse
      ? `http://localhost:${config.LANGFUSE_PORT}`
      : "https://cloud.langfuse.com")
  ).replace(/\/$/, "");

  return {
    baseUrl,
    ...(config.LANGFUSE_PUBLIC_KEY
      ? { publicKey: config.LANGFUSE_PUBLIC_KEY }
      : {}),
    ...(config.LANGFUSE_SECRET_KEY
      ? { secretKey: config.LANGFUSE_SECRET_KEY }
      : {}),
  };
}
