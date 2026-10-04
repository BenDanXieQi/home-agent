import { appearanceSummarySchema } from "@home-agent/api/contracts";
import { z } from "zod";

// Private evidence boundary. Public identity results never contain this schema.
export const appearanceEvidenceSchema = appearanceSummarySchema.extend({
  vector: z
    .array(z.number().finite())
    .length(128)
    .refine(
      (vector) => Math.abs(Math.hypot(...vector) - 1) <= 0.001,
      "Appearance feature must be normalized",
    ),
});
