import { appearanceSummarySchema } from "@home-agent/api/contracts";
import { referenceAppearanceSchema } from "./contracts";

export const appearanceEvidenceSchema = appearanceSummarySchema.extend({
  vector: referenceAppearanceSchema.shape.vector,
});
