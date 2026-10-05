import type { z } from "zod";
import type { identityReferenceSnapshotSchema } from "@home-agent/api/contracts";

function normalize(vector: number[]) {
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}
export function createReferences(
  input: Pick<z.infer<typeof identityReferenceSnapshotSchema>, "members">,
) {
  const members = input.members
    .filter((member) => member.enabled)
    .map((member) => ({
      label: member.memberId,
      className: member.className,
      threshold: member.threshold,
      margin: member.margin,
      vectors: member.references.map((reference) =>
        normalize(reference.feature),
      ),
    }));
  function candidates(
    className: z.infer<
      typeof identityReferenceSnapshotSchema
    >["members"][number]["className"],
  ) {
    // Cat and dog crops use the same embedding model and preparation.
    // Detection chooses the identity family, not a closed species gallery.
    return members.filter((member) =>
      className === "human"
        ? member.className === "human"
        : member.className !== "human",
    );
  }
  return {
    hasCandidates(className: Parameters<typeof candidates>[0]) {
      return candidates(className).length > 0;
    },
    rank(
      feature: number[],
      className: z.infer<
        typeof identityReferenceSnapshotSchema
      >["members"][number]["className"],
    ) {
      const normalized = normalize(feature);
      return candidates(className)
        .map(
          ({
            label,
            className: referenceClass,
            vectors,
            threshold,
            margin,
          }) => ({
            threshold,
            margin,
            label,
            className: referenceClass,
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
          }),
        )
        .toSorted(
          (a, b) =>
            b.score - a.score ||
            Number(b.className === className) -
              Number(a.className === className) ||
            a.label.localeCompare(b.label),
        );
    },
  };
}
