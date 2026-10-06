import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";

export const collectionLimits = {
  properties: 20_000,
  latestBytes: 2 * 1024 * 1024,
  valueBytes: 16 * 1024,
  messageBytes: 256 * 1024,
  queued: 2048,
  queuedBytes: 4 * 1024 * 1024,
  batch: 128,
  readConcurrent: 4,
  readBatch: 50,
  readPending: 100,
  readTimeoutMs: 35_000,
  samples: 100,
  sampleBytes: 256 * 1024,
  overloadLimit: 3,
  overloadWindowMs: 60_000,
} as const;
const freshnessSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("unknown") }),
  z.strictObject({
    mode: z.literal("ttl"),
    max_age_ms: z.number().int().min(1000).max(86_400_000),
  }),
  z.strictObject({ mode: z.literal("change") }),
]);
export const propertyPolicySchema = z
  .strictObject({
    model: z.string().min(1).max(256),
    spec_id: z.string().min(1).max(256).nullable(),
    siid: z.number().int().positive(),
    piid: z.number().int().positive(),
    read: z.boolean(),
    verified_push: z.boolean(),
    freshness: freshnessSchema,
  })
  .refine(
    (policy) => policy.freshness.mode === "unknown" || policy.verified_push,
    {
      message: "Freshness requires a verified push source",
    },
  );
export const collectionPolicySchema = z
  .strictObject({
    properties: z.array(propertyPolicySchema).max(2000),
  })
  .refine(
    (config) => {
      const identities = config.properties.map(
        ({ model, spec_id, siid, piid }) =>
          JSON.stringify([model, spec_id, siid, piid]),
      );
      return new Set(identities).size === identities.length;
    },
    { message: "Duplicate property policies" },
  );
export function configureCollection(input: unknown) {
  const policy = collectionPolicySchema.parse(input);
  return {
    ...policy,
    version: createHash("sha256")
      .update(JSON.stringify(policy))
      .digest("hex")
      .slice(0, 16),
  };
}
export const defaultCollectionPolicy = configureCollection({ properties: [] });
export function propertyPolicy(
  config: typeof defaultCollectionPolicy,
  model: string,
  specId: string | null,
  siid: number,
  piid: number,
) {
  return (
    config.properties.find(
      (item) =>
        item.model === model &&
        item.spec_id === specId &&
        item.siid === siid &&
        item.piid === piid,
    ) ??
    config.properties.find(
      (item) =>
        item.model === model &&
        item.spec_id === null &&
        item.siid === siid &&
        item.piid === piid,
    )
  );
}
export async function loadCollectionPolicy(path: string) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return defaultCollectionPolicy;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 256 * 1024)
      throw new Error("Invalid collection policy file");
    const buffer = Buffer.alloc(256 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 256 * 1024)
      throw new Error("Collection policy exceeds limit");
    return configureCollection(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
    );
  } finally {
    await file.close();
  }
}
