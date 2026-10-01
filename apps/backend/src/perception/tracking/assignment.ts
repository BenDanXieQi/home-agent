import { munkres } from "munkres";

// Dummy columns permit unmatched tracks. Their penalty makes cardinality take
// precedence over cost; gated edges can never beat an available dummy column.
export function assign(costs: number[][], threshold: number) {
  const columns = costs[0]?.length ?? 0;
  if (!columns) return [];
  const unmatched = (costs.length + 1) * (threshold + 1);
  return munkres(
    costs.map((row) => [
      ...row.map((cost) =>
        Number.isFinite(cost) && cost <= threshold ? cost : Infinity,
      ),
      ...Array<number>(costs.length).fill(unmatched),
    ]),
  )
    .filter(([, column]) => column < columns)
    .toSorted((a, b) => a[1] - b[1]);
}
export function iou(
  a: { x: number; y: number; w: number; h: number },
  b: typeof a,
) {
  const intersection =
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return intersection / (a.w * a.h + b.w * b.h - intersection);
}
