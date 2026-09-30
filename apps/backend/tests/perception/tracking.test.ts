import { expect, test } from "bun:test";
import { createHumanTracker } from "../../src/perception/tracking/tracker";
import { assign } from "../../src/perception/tracking/assignment";
import {
  initiate,
  predict,
  correct,
  predictedBox,
} from "../../src/perception/tracking/kalman";
const person = (x: number, confidence = 0.9) => ({
  x,
  y: 10,
  w: 40,
  h: 100,
  confidence,
  className: "human" as const,
  classId: 0,
});
const feature = (index: number) =>
  Array.from({ length: 128 }, (_, i) => (i === index ? 1 : 0));

test("global assignment avoids greedy collisions and rejects gated pairs", () => {
  expect(
    assign(
      [
        [0.1, 0.2],
        [0.15, Infinity],
      ],
      0.2,
    ),
  ).toEqual([
    [1, 0],
    [0, 1],
  ]);
  expect(assign([[Infinity]], 0.2)).toEqual([]);
});
test("appearance keeps two crossing people separate even when detection order reverses", () => {
  const tracker = createHumanTracker();
  const first = tracker.begin(0, [person(10), person(80)]);
  expect(
    tracker.finish(first, [feature(0), feature(1)]).map((t) => t.trackId),
  ).toEqual([1, 2]);
  for (let step = 1; step <= 7; step++) {
    const input = tracker.begin(step * 150, [
      person(80 - step * 10),
      person(10 + step * 10),
    ]);
    const result = tracker.finish(input, [feature(1), feature(0)]);
    expect(result.find((t) => t.trackId === 1)?.measuredBox?.x).toBe(
      10 + step * 10,
    );
    expect(result.find((t) => t.trackId === 2)?.measuredBox?.x).toBe(
      80 - step * 10,
    );
  }
});
test("occlusion predicts separately, retains for real seconds, and reentry after expiry gets a new id", () => {
  const tracker = createHumanTracker();
  tracker.finish(tracker.begin(0, [person(20)]), [feature(0)]);
  const missing = tracker.finish(tracker.begin(500, []), []);
  expect(missing[0]).toMatchObject({
    trackId: 1,
    state: "predicted",
    measuredBox: null,
    lastMeasuredAt: 0,
    feature: "missing",
  });
  expect(
    tracker.finish(tracker.begin(1900, [person(20)]), [feature(0)])[0]?.trackId,
  ).toBe(1);
  expect(
    tracker.finish(tracker.begin(4001, [person(20)]), [feature(0)])[0]?.trackId,
  ).toBe(2);
});
test("Kalman prediction uses elapsed seconds rather than processed frame count", () => {
  const a = initiate(person(0));
  predict(a, 0.5);
  correct(a, person(15));
  const b = structuredClone(a),
    c = structuredClone(a);
  predict(b, 1);
  predict(c, 0.25);
  const before = predictedBox(a).x;
  expect(
    (predictedBox(b).x - before) / (predictedBox(c).x - before),
  ).toBeCloseTo(4);
});
test("fast cache counts tracker updates, requires static history and refreshes at four", () => {
  const tracker = createHumanTracker();
  tracker.finish(tracker.begin(0, [person(10)]), [feature(0)]);
  const second = tracker.begin(100, [person(10)]);
  expect(second.cached[0]).toBeNull();
  tracker.finish(second, [feature(0)]);
  for (let n = 2; n < 5; n++) {
    const input = tracker.begin(n * 100, [person(10)]);
    expect(input.cached[0]?.trackId).toBe(1);
    expect(tracker.finish(input, [input.cached[0]!.vector])[0]?.feature).toBe(
      "reused",
    );
  }
  expect(tracker.begin(500, [person(10)]).cached[0]).toBeNull();
});
test("missing features remain explicit, non-human and low-confidence boxes do not create tracks", () => {
  const tracker = createHumanTracker();
  const input = tracker.begin(0, [
    person(10, 0.49),
    { ...person(50), className: "cat", classId: 1 },
    person(90),
  ]);
  const result = tracker.finish(input, [null]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    feature: "missing",
    featureAt: null,
    state: "measured",
  });
  tracker.reset();
  expect(
    tracker.finish(tracker.begin(200, [person(90)]), [null])[0]?.trackId,
  ).toBe(2);
});
test("track count and out-of-order input are bounded", () => {
  const tracker = createHumanTracker();
  const input = tracker.begin(
    1,
    Array.from({ length: 30 }, (_, i) => person(i * 100)),
  );
  expect(
    tracker.finish(
      input,
      input.humans.map(() => null),
    ),
  ).toHaveLength(8);
  expect(() => tracker.begin(1, [])).toThrow("increase");
});

test("seconds-based velocity learns motion across irregular sampling gaps", () => {
  const tracker = createHumanTracker();
  for (const [at, x] of [
    [0, 0],
    [200, 30],
    [500, 75],
    [1100, 165],
    [1700, 255],
  ]) {
    const result = tracker.finish(tracker.begin(at!, [person(x!)]), [
      feature(0),
    ]);
    expect(
      result
        .filter((track) => track.state === "measured")
        .map((track) => track.trackId),
    ).toEqual([1]);
  }
});
