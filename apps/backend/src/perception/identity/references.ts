import { z } from "zod";
import { identityCapacity } from "@home-agent/api/contracts";
import { featureSchema } from "./evidence";

export const referenceSetSchema = z.object({
  threshold: z.number().min(-1).max(1.000001),
  margin: z.number().min(0).max(2),
  gallery: z
    .record(
      z.string().min(1).max(identityCapacity.labelLength),
      z
        .array(
          z.object({
            feature: featureSchema,
            frame: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        )
        .min(1)
        .max(identityCapacity.referencesPerMember),
    )
    .refine(
      (members) =>
        Object.keys(members).length > 0 &&
        Object.keys(members).length <= identityCapacity.members,
      `Reference set supports 1–${identityCapacity.members} labels`,
    ),
});
function normalize(vector: number[]) {
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}
export function createReferences(input: z.infer<typeof referenceSetSchema>) {
  const members = Object.entries(input.gallery).map(([label, references]) => ({
    label,
    vectors: references.map((reference) => normalize(reference.feature)),
  }));
  return {
    threshold: input.threshold,
    margin: input.margin,
    rank(feature: number[]) {
      const normalized = normalize(feature);
      return members
        .map(({ label, vectors }) => ({
          label,
          score: Math.max(
            ...vectors.map((vector) =>
              Math.min(
                1,
                Math.max(
                  -1,
                  vector.reduce(
                    (sum, value, index) => sum + value * normalized[index]!,
                    0,
                  ),
                ),
              ),
            ),
          ),
        }))
        .toSorted(
          (a, b) => b.score - a.score || a.label.localeCompare(b.label),
        );
    },
  };
}
