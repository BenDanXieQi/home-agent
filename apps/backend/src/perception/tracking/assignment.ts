// Exact minimum-cost assignment with optional unmatched rows. At most eight
// tracks gives 256 masks; bounded detections avoid an unbounded matching matrix.
export function assign(costs: number[][], threshold: number) {
  const columns = costs[0]?.length ?? 0;
  let states = new Map<number, { cost: number; pairs: [number, number][] }>([
    [0, { cost: 0, pairs: [] }],
  ]);
  for (let column = 0; column < columns; column++) {
    const next = new Map(states);
    for (const [mask, state] of states) {
      for (let row = 0; row < costs.length; row++) {
        const cost = costs[row]![column]!;
        if (mask & (1 << row) || cost > threshold || !Number.isFinite(cost))
          continue;
        const key = mask | (1 << row);
        // Unmatched costs exceed every accepted edge, maximizing cardinality first.
        const candidate =
          state.cost + cost - (costs.length + 1) * (threshold + 1);
        if (candidate < (next.get(key)?.cost ?? Infinity))
          next.set(key, {
            cost: candidate,
            pairs: [...state.pairs, [row, column]],
          });
      }
    }
    states = next;
  }
  return [...states.values()].reduce((best, state) =>
    state.cost < best.cost ? state : best,
  ).pairs;
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
