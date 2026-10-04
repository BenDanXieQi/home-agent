import { z } from "zod";
import { trackingObservationSchema } from "@home-agent/api/contracts";
import { identityLimits } from "./config";

import { identityEvidenceSchema } from "./evidence";
import profile from "./profile.json";
export const faceRequestSchema = z.object({
  rgb: z.string().max(profile.width * profile.height * 4),
  tracks: z
    .array(
      trackingObservationSchema.shape.tracks.element
        .pick({
          trackId: true,
          measuredBox: true,
        })
        .extend({
          measuredBox:
            trackingObservationSchema.shape.tracks.element.shape.measuredBox.unwrap(),
        }),
    )
    .max(identityLimits.tracksPerRun),
  targets: z.array(z.int().positive()).max(identityLimits.facesPerFrame),
  minimumSharpness: z.number().nonnegative(),
});
export const faceResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), opencv: z.string() }),
  identityEvidenceSchema.extend({ kind: z.literal("result") }),
]);
