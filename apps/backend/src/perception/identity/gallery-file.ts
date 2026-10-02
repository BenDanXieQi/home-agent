import { identityCapacity } from "@home-agent/api/contracts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { createReferences, referenceSetSchema } from "./references";
import models from "./models.json";
import profile from "./profile.json";

const frozenSchema = referenceSetSchema.extend({
  models: z.unknown(),
  policy: z.object({
    width: z.literal(profile.width),
    height: z.literal(profile.height),
    detectorScore: z.literal(profile.detectorScore),
    minimumFaceSide: z.literal(profile.minimumFaceSide),
    nms: z.literal(profile.nms),
    topK: z.literal(profile.topK),
    minimumSharpness: z.number().nonnegative().max(10_000),
    referenceAggregation: z.literal("max cosine per member"),
  }),
});
export async function loadGallery(
  path: string | null,
  minimumSharpness: number,
) {
  if (path === null) return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > identityCapacity.galleryBytes)
      throw new Error(
        "Identity gallery must be a regular file of at most 4 MiB",
      );
    const bytes = Buffer.alloc(identityCapacity.galleryBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > identityCapacity.galleryBytes)
      throw new Error("Identity gallery exceeds 4 MiB");
    const content = bytes.subarray(0, bytesRead);
    return parseGallery(content, minimumSharpness);
  } finally {
    await file.close();
  }
}

export function parseGallery(content: Buffer, minimumSharpness: number) {
  if (content.length > identityCapacity.galleryBytes)
    throw new Error("Identity gallery exceeds byte budget");
  const frozen = frozenSchema.parse(JSON.parse(content.toString("utf8")));
  if (frozen.policy.minimumSharpness !== minimumSharpness)
    throw new Error("Identity quality policy differs from calibration");
  if (!isDeepStrictEqual(frozen.models, models))
    throw new Error("Identity gallery model contract differs from runtime");
  return {
    revision: createHash("sha256").update(content).digest("hex"),
    references: createReferences(frozen),
  };
}
