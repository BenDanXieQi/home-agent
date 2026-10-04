import { trackingObservationSchema } from "@home-agent/api/contracts";
import { z } from "zod";

// Private evidence boundary. Public identity results never contain this schema.
export const appearanceEvidenceSchema = trackingObservationSchema
  .pick({
    run: true,
    sequence: true,
    receivedAt: true,
    sampledAt: true,
    mediaTime: true,
    ageMs: true,
    width: true,
    height: true,
    coordinateBasis: true,
  })
  .extend({
    trackId: z.int().positive(),
    modelVersion: z.string().min(1).max(128),
    processingVersion: z.string().min(1).max(128),
    vector: z
      .array(z.number().finite())
      .length(128)
      .refine(
        (vector) => Math.abs(Math.hypot(...vector) - 1) <= 0.001,
        "Appearance feature must be normalized",
      ),
  });
