import { expect, test } from "bun:test";
import { createPetTracker } from "../../src/perception/tracking/pet-tracker";
import { createHumanTracker } from "../../src/perception/tracking/tracker";
import { createTrackIds } from "../../src/perception/tracking/track-ids";

const pet = (className: "cat" | "dog", x: number, confidence = 0.9) => ({
  x,
  y: 10,
  w: 60,
  h: 40,
  className,
  classId: className === "cat" ? 1 : 2,
  confidence,
});
test("cats and dogs retain distinct ids while detections change order and position", () => {
  const tracker = createPetTracker();
  const first = tracker.update(0, [pet("cat", 10), pet("dog", 100)]);
  const next = tracker.update(300, [pet("dog", 95), pet("cat", 15)]);
  expect(next.map((t) => [t.trackId, t.className, t.measuredBox?.x])).toEqual([
    [first[0]!.trackId, "cat", 15],
    [first[1]!.trackId, "dog", 95],
  ]);
  expect(
    next.every((t) => t.feature === "not_applicable" && t.featureAt === null),
  ).toBe(true);
});
test("overlapping species never acquire each other's track id", () => {
  const tracker = createPetTracker();
  const catId = tracker.update(0, [pet("cat", 10)])[0]!.trackId;
  const result = tracker.update(300, [pet("dog", 10)]);
  expect(result.find((t) => t.trackId === catId)).toMatchObject({
    className: "cat",
    state: "predicted",
    measuredBox: null,
  });
  expect(result.find((t) => t.className === "dog")?.trackId).not.toBe(catId);
});
test("brief misses can resume a motion-consistent pet; expiry and far reentry allocate new ids", () => {
  const tracker = createPetTracker();
  const id = tracker.update(0, [pet("cat", 10)])[0]!.trackId;
  expect(tracker.update(800, [])[0]).toMatchObject({
    trackId: id,
    state: "predicted",
    measuredBox: null,
    lastMeasuredAt: 0,
  });
  expect(tracker.update(1800, [pet("cat", 10)])[0]).toMatchObject({
    trackId: id,
    state: "measured",
  });
  const far = tracker
    .update(1900, [pet("cat", 500)])
    .find((t) => t.state === "measured")!;
  expect(far.trackId).not.toBe(id);
  expect(tracker.update(4001, [pet("cat", 500)])[0]!.trackId).not.toBe(
    far.trackId,
  );
});
test("same-species trajectories follow learned motion through a sampled crossing", () => {
  const tracker = createPetTracker();
  tracker.update(0, [pet("cat", 0), pet("cat", 120)]);
  for (let step = 1; step <= 8; step++) {
    const result = tracker.update(step * 300, [
      pet("cat", 120 - step * 15),
      pet("cat", step * 15),
    ]);
    expect(result.find((t) => t.trackId === 1)?.measuredBox?.x).toBe(step * 15);
    expect(result.find((t) => t.trackId === 2)?.measuredBox?.x).toBe(
      120 - step * 15,
    );
  }
});
test("pets share a bounded eight-slot budget and exclude human, head and weak detections", () => {
  const tracker = createPetTracker();
  const result = tracker.update(0, [
    { ...pet("cat", 0), className: "human", classId: 0 },
    { ...pet("cat", 0), className: "head", classId: 3 },
    pet("cat", 0, 0.49),
    ...Array.from({ length: 20 }, (_, i) =>
      pet(i % 2 ? "cat" : "dog", i * 100),
    ),
  ]);
  expect(result).toHaveLength(8);
  expect(() => tracker.update(0, [])).toThrow("increase");
});
test("source-run allocator stays unique across species and tracker resets", () => {
  const allocateId = createTrackIds(),
    humans = createHumanTracker(allocateId),
    pets = createPetTracker(allocateId);
  const human = { ...pet("cat", 0), className: "human" as const, classId: 0 };
  const h = humans.finish(humans.begin(0, [human]), [null]);
  const p = pets.update(0, [pet("cat", 0), pet("dog", 100)]);
  expect(new Set([...h, ...p].map((t) => t.trackId)).size).toBe(3);
  humans.reset();
  pets.reset();
  const next = pets.update(500, [pet("cat", 0)]);
  expect(next[0]!.trackId).toBeGreaterThan(
    Math.max(...[...h, ...p].map((t) => t.trackId)),
  );
});

test("weak pet boxes only continue confirmed same-species tracks and high scores win", () => {
  const tracker = createPetTracker(undefined, {
    continuationConfidence: 0.1,
    newTrackConfidence: 0.6,
  });
  expect(tracker.update(0, [pet("cat", 10, 0.2)])).toEqual([]);
  const id = tracker.update(300, [pet("cat", 10)])[0]!.trackId;
  expect(tracker.update(600, [pet("cat", 10, 0.2)])[0]).toMatchObject({
    trackId: id,
    state: "measured",
  });
  expect(
    tracker.update(900, [pet("cat", 10, 0.2), pet("cat", 12, 0.9)])[0]
      ?.measuredBox?.confidence,
  ).toBe(0.9);
  const result = tracker.update(1200, [pet("dog", 12, 0.2)]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    trackId: id,
    className: "cat",
    state: "predicted",
  });
  expect(
    tracker
      .update(1500, [pet("dog", 12, 0.55)])
      .some((t) => t.className === "dog"),
  ).toBe(false);
});

test("two-of-three confirmation tolerates one missed frame but never confirms on weak evidence", () => {
  const tracker = createPetTracker(undefined, {
    continuationConfidence: 0.1,
    confirmationHits: 2,
  });
  expect(tracker.update(0, [pet("cat", 10)])).toEqual([]);
  expect(tracker.update(300, [pet("cat", 10, 0.2)])).toEqual([]);
  const confirmed = tracker.update(600, [pet("cat", 10)]);
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0]).toMatchObject({
    hits: 2,
    state: "measured",
    lastMeasuredAt: 600,
  });
  expect(tracker.update(900, [pet("cat", 10, 0.2)])[0]).toMatchObject({
    trackId: confirmed[0]!.trackId,
    state: "measured",
  });
});

test("unconfirmed single-frame candidates expire instead of filling every track slot", () => {
  const tracker = createPetTracker(undefined, { confirmationHits: 2 });
  expect(
    tracker.update(
      0,
      Array.from({ length: 8 }, (_, i) => pet("cat", i * 100)),
    ),
  ).toEqual([]);
  expect(tracker.update(300, [])).toEqual([]);
  expect(tracker.update(600, [pet("dog", 1000)])).toEqual([]);
  expect(
    tracker.update(900, [pet("dog", 1000)]).map((t) => t.className),
  ).toEqual(["dog"]);
});

test("confirmation uses a sliding window after an initial missed observation", () => {
  const tracker = createPetTracker(undefined, { confirmationHits: 3 });
  expect(tracker.update(0, [pet("cat", 10)])).toEqual([]);
  expect(tracker.update(300, [])).toEqual([]);
  expect(tracker.update(600, [pet("cat", 10)])).toEqual([]);
  expect(tracker.update(900, [pet("cat", 10)])).toEqual([]);
  expect(tracker.update(1200, [pet("cat", 10)])[0]).toMatchObject({
    hits: 4,
    state: "measured",
  });
});
