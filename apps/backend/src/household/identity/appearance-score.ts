// Inputs are normalized ReID vectors accepted by the private evidence boundary.
export function appearanceScore(vector: number[], reference: number[]) {
  return Math.max(
    -1,
    Math.min(
      1,
      vector.reduce(
        (total, value, index) => total + value * reference[index]!,
        0,
      ),
    ),
  );
}
