// Independent constant-velocity axes for DeepSORT's x/y/aspect/height state.
// Covariance stays block diagonal: measurements and process noise do not couple axes.
export function measurement(box: {
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  return [box.x + box.w / 2, box.y + box.h / 2, box.w / box.h, box.h];
}
export function initiate(box: Parameters<typeof measurement>[0]) {
  return measurement(box).map((position, i) => ({
    position,
    velocity: 0,
    pp: (i === 2 ? 0.01 : box.h / 10) ** 2,
    pv: 0,
    // Velocity is pixels/second: allow half a body height per second at birth.
    vv: (i === 2 ? 0.01 : box.h / 2) ** 2,
  }));
}
export function predict(state: ReturnType<typeof initiate>, seconds: number) {
  const height = Math.max(1, state[3]!.position);
  for (const [i, axis] of state.entries()) {
    const acceleration = (i === 2 ? 0.01 : height / 20) ** 2;
    axis.position += axis.velocity * seconds;
    axis.pp +=
      2 * seconds * axis.pv +
      seconds ** 2 * axis.vv +
      (i === 2 ? 0.01 : height / 20) ** 2 * seconds +
      (acceleration * seconds ** 3) / 3;
    axis.pv += seconds * axis.vv + (acceleration * seconds ** 2) / 2;
    axis.vv += acceleration * seconds;
  }
}
function variance(state: ReturnType<typeof initiate>, i: number) {
  return (i === 2 ? 0.1 : Math.max(1, state[3]!.position) / 20) ** 2;
}
export function distance(
  state: ReturnType<typeof initiate>,
  box: Parameters<typeof measurement>[0],
) {
  return measurement(box).reduce(
    (sum, value, i) =>
      sum +
      (value - state[i]!.position) ** 2 / (state[i]!.pp + variance(state, i)),
    0,
  );
}
export function correct(
  state: ReturnType<typeof initiate>,
  box: Parameters<typeof measurement>[0],
) {
  const values = measurement(box);
  const noise = state.map((_, i) => variance(state, i));
  for (const [i, axis] of state.entries()) {
    const innovation = values[i]! - axis.position;
    const total = axis.pp + noise[i]!;
    const kp = axis.pp / total,
      kv = axis.pv / total;
    axis.position += kp * innovation;
    axis.velocity += kv * innovation;
    axis.vv -= kv * axis.pv;
    axis.pv *= 1 - kp;
    axis.pp *= 1 - kp;
  }
}
export function predictedBox(state: ReturnType<typeof initiate>) {
  const h = Math.max(1, state[3]!.position);
  const w = Math.max(1, state[2]!.position * h);
  return { x: state[0]!.position - w / 2, y: state[1]!.position - h / 2, w, h };
}
