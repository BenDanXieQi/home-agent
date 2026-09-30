import { resolveComputeBudget } from "../../src/perception/compute/budget";
import { expect, test } from "bun:test";
import { createFrameSchedule } from "../../scripts/benchmark-detection";
import { createPerceptionReport } from "../../scripts/perception-report";

test("late producer callbacks count missed frames without replaying a burst", () => {
  const schedule = createFrameSchedule(10, 1000);
  expect(schedule.takeDue(0)).toBe(true);
  expect(schedule.takeDue(50)).toBe(false);
  expect(schedule.takeDue(350)).toBe(true);
  expect(schedule.takeDue(350)).toBe(false);
  expect(schedule.nextDelayMs(350)).toBe(50);
  expect(schedule.takeDue(1000)).toBe(false);
  expect(schedule.nextDelayMs(1000)).toBeUndefined();
  expect(schedule.finish()).toEqual({
    planned: 10,
    offered: 2,
    missedDueToEventLoop: 8,
  });
  expect(schedule.finish().missedDueToEventLoop).toBe(8);
});

test("on-time producer callbacks offer every planned frame exactly once", () => {
  const schedule = createFrameSchedule(10, 1000);
  for (let elapsed = 0; elapsed < 1000; elapsed += 100)
    expect(schedule.takeDue(elapsed)).toBe(true);
  expect(schedule.takeDue(1100)).toBe(false);
  expect(schedule.finish()).toEqual({
    planned: 10,
    offered: 10,
    missedDueToEventLoop: 0,
  });
});

test("report uses worker model metadata without opening the model file", async () => {
  const metadata = {
    // Deliberately absent: only the managed worker opens and hashes assets.
    modelPath: "/worker-owned/model.onnx",
    sha256: "a".repeat(64),
    input: {
      name: "images",
      isTensor: true,
      type: "float32",
      shape: [1, 3, 416, 416],
    },
    output: {
      name: "output0",
      isTensor: true,
      type: "float32",
      shape: [1, 9, 3549],
    },
    provider: "cpu",
    sharpConcurrency: 1,
    workerThreadIds: [1],
    intraOpNumThreads: 1,
  } satisfies Parameters<typeof createPerceptionReport>[0];
  const report = await createPerceptionReport(
    metadata,
    resolveComputeBudget(1, 1),
  );
  expect(report.metadata).toEqual(metadata);
});
