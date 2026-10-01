import { createRequire } from "node:module";
import { z } from "zod";

// The published CommonJS library has no declarations. Validate its public
// constructors and numeric output at this boundary instead of trusting any.
const native = z
  .object({
    KalmanFilter: z.instanceof(Function),
    State: z.instanceof(Function),
  })
  .parse(createRequire(import.meta.url)("kalman-filter"));
const pair = z.tuple([z.number(), z.number()]);
const nativeState = z.object({
  mean: z.tuple([z.tuple([z.number()]), z.tuple([z.number()])]),
  covariance: z.tuple([pair, pair]),
});

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
function step(
  axis: ReturnType<typeof initiate>[number],
  seconds: number,
  noise: number[][],
  observation?: { value: number; variance: number },
) {
  const filter: object = Reflect.construct(native.KalmanFilter, [
    {
      dynamic: {
        dimension: 2,
        transition: [
          [1, seconds],
          [0, 1],
        ],
        covariance: noise,
      },
      observation: {
        dimension: 1,
        stateProjection: [[1, 0]],
        covariance: [[observation?.variance ?? 1]],
      },
    },
  ]);
  const previous: object = Reflect.construct(native.State, [
    {
      mean: [[axis.position], [axis.velocity]],
      covariance: [
        [axis.pp, axis.pv],
        [axis.pv, axis.vv],
      ],
    },
  ]);
  const operation = z
    .instanceof(Function)
    .parse(Reflect.get(filter, observation ? "correct" : "predict"));
  const result = nativeState.parse(
    operation.call(
      filter,
      observation
        ? { predicted: previous, observation: [[observation.value]] }
        : { previousCorrected: previous },
    ),
  );
  axis.position = result.mean[0][0];
  axis.velocity = result.mean[1][0];
  axis.pp = result.covariance[0][0];
  axis.pv = result.covariance[0][1];
  axis.vv = result.covariance[1][1];
}
export function predict(state: ReturnType<typeof initiate>, seconds: number) {
  const height = Math.max(1, state[3]!.position);
  for (const [i, axis] of state.entries()) {
    const acceleration = (i === 2 ? 0.01 : height / 20) ** 2;
    step(axis, seconds, [
      [
        acceleration * seconds + (acceleration * seconds ** 3) / 3,
        (acceleration * seconds ** 2) / 2,
      ],
      [(acceleration * seconds ** 2) / 2, acceleration * seconds],
    ]);
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
  for (const [i, axis] of state.entries())
    step(
      axis,
      0,
      [
        [0, 0],
        [0, 0],
      ],
      { value: values[i]!, variance: noise[i]! },
    );
}

export function predictedBox(state: ReturnType<typeof initiate>) {
  const h = Math.max(1, state[3]!.position);
  const w = Math.max(1, state[2]!.position * h);
  return { x: state[0]!.position - w / 2, y: state[1]!.position - h / 2, w, h };
}
