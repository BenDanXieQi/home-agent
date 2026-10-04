import type { z } from "zod";
import type { identityReferenceSnapshotSchema } from "@home-agent/api/contracts";

function normalize(vector: number[]) {
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}
export function createReferences(
  input: Pick<z.infer<typeof identityReferenceSnapshotSchema>, "members">,
) {
  const members = input.members.map((member) => ({
    label: member.memberId,
    className: member.className,
    threshold: member.threshold,
    margin: member.margin,
    vectors: member.references.map((reference) => normalize(reference.feature)),
  }));
  return {
    rank(
      feature: number[],
      className: z.infer<
        typeof identityReferenceSnapshotSchema
      >["members"][number]["className"],
    ) {
      const normalized = normalize(feature);
      return members
        .filter((member) => member.className === className)
        .map(({ label, vectors, threshold, margin }) => ({
          threshold,
          margin,
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
