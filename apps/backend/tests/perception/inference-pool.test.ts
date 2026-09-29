import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { queueOptionsSymbol, type Piscina } from "piscina";
import { detectionComputeBudget } from "../../src/perception/compute/budget";
import type run from "../../src/perception/compute/inference-worker";

const originalBudget = detectionComputeBudget;
const budget = {
  ...detectionComputeBudget,
  workersPerProcess: 1,
  tasksPerWorker: 1,
};
await mock.module("../../src/perception/compute/budget", () => ({
  detectionComputeBudget: budget,
}));

class Pool extends EventEmitter {
  run = mock<
    Piscina<Parameters<typeof run>[0], Awaited<ReturnType<typeof run>>>["run"]
  >(async () => ({ kind: "closed" }));
  close = mock(async () => {});
}
let native: Pool;
const original = { ...(await import("piscina")) };
const constructor = mock(function (
  _options: ConstructorParameters<typeof original.Piscina>[0],
) {
  return native;
});
await mock.module("piscina", () => ({ ...original, Piscina: constructor }));
const { createInferencePool } =
  await import("../../src/perception/compute/inference-pool");
afterAll(async () => {
  await mock.module("piscina", () => original);
  await mock.module("../../src/perception/compute/budget", () => ({
    detectionComputeBudget: originalBudget,
  }));
});
beforeEach(() => {
  native = new Pool();
  constructor.mockClear();
  budget.workersPerProcess = 1;
  budget.tasksPerWorker = 1;
});

test("close drains native work and releases the model before closing idle threads", async () => {
  const work = Promise.withResolvers<{ kind: "closed" }>();
  const release = Promise.withResolvers<{ kind: "closed" }>();
  native.run
    .mockImplementationOnce(() => work.promise)
    .mockImplementationOnce(() => release.promise);
  const pool = createInferencePool(() => {});
  const pending = pool.submit({ kind: "initialize" });
  const closing = pool.close();
  expect(pool.close()).toBe(closing);
  await delay(1);
  expect(native.run).toHaveBeenCalledTimes(1);
  expect(native.close).not.toHaveBeenCalled();
  await expect(pool.submit({ kind: "close" })).rejects.toThrow("closing");
  work.resolve({ kind: "closed" });
  await pending;
  await delay(1);
  expect(native.run).toHaveBeenLastCalledWith({ kind: "close" });
  expect(native.close).not.toHaveBeenCalled();
  release.resolve({ kind: "closed" });
  await closing;
  expect(native.close).toHaveBeenCalledTimes(1);
});

test("release failure leaves thread teardown to the outer process boundary", async () => {
  native.run.mockRejectedValueOnce(new Error("release failed"));
  const pool = createInferencePool(() => {});
  await expect(pool.close()).rejects.toThrow("release failed");
  expect(native.close).not.toHaveBeenCalled();
});

test("worker failure reports outward and prevents new native tasks", async () => {
  const onFailure = mock(() => {});
  const pool = createInferencePool(onFailure);
  const error = new Error("worker failed");
  native.emit("error", error);
  expect(onFailure).toHaveBeenCalledWith(error);
  await expect(pool.submit({ kind: "close" })).rejects.toThrow("worker failed");
  await expect(pool.close()).rejects.toThrow("worker failed");
  expect(native.run).not.toHaveBeenCalled();
  expect(native.close).not.toHaveBeenCalled();
});

test("known image failures cross the worker boundary without losing their code", async () => {
  native.run.mockResolvedValueOnce({
    kind: "image_failed",
    code: "invalid_image",
    message: "Cannot decode image: unsupported format",
    stack: "ImageProcessingError: unsupported format",
  });
  const pool = createInferencePool(() => {});
  await expect(
    pool.submit({ kind: "detect_image", image: { path: "/bad.png" } }),
  ).rejects.toMatchObject({
    code: "invalid_image",
    message: "Cannot decode image: unsupported format",
  });
  await pool.close();
});

test("only the child-owned pixel buffer is transferred to Piscina", async () => {
  const pixels = new Uint8Array([10, 20, 30]);
  native.run.mockImplementationOnce(async (task, options) => {
    expect(options?.transferList).toEqual([pixels.buffer]);
    const received = structuredClone(task, {
      transfer: options?.transferList ?? [],
    });
    expect(received).toMatchObject({
      kind: "detect",
      frame: { rgb: new Uint8Array([10, 20, 30]) },
    });
    return { kind: "closed" };
  });
  const pool = createInferencePool(() => {});
  await pool.submit({
    kind: "detect",
    frame: { width: 1, height: 1, rgb: pixels },
  });
  expect(pixels.byteLength).toBe(0);
  await pool.close();
});

test.each(["workersPerProcess", "tasksPerWorker"] as const)(
  "rejects %s changes that would break single-session ownership",
  (option) => {
    budget[option] = 2;
    expect(() => createInferencePool(() => {})).toThrow(
      "one worker and one task per worker",
    );
    expect(constructor).not.toHaveBeenCalled();
  },
);

test("reports zero queue time for immediate dispatch and excludes worker duration", async () => {
  let now = 100;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const pool = createInferencePool(() => {});
  native.run.mockImplementationOnce(async () => {
    now = 150;
    return {
      kind: "detected",
      detections: [],
      timing: {
        readMs: 0,
        decodeMs: 0,
        preprocessMs: 5,
        inferenceMs: 20,
        postprocessMs: 1,
        workerMs: 30,
      },
    };
  });
  try {
    const result = await pool.submit({
      kind: "detect",
      frame: { width: 1, height: 1, rgb: new Uint8Array(3) },
    });
    expect(result).toMatchObject({
      timing: { queueMs: 0, workerDispatchMs: 20 },
    });
  } finally {
    clock.mockRestore();
    await pool.close();
  }
});

test("reports actual queue residence separately from thread dispatch overhead", async () => {
  let now = 100;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const pool = createInferencePool(() => {});
  const queue = constructor.mock.calls[0]?.[0]?.taskQueue;
  if (!queue) throw new Error("Missing inference queue");
  native.run.mockImplementationOnce(async (task) => {
    if (!(queueOptionsSymbol in task)) throw new Error("Missing queue key");
    const key = task[queueOptionsSymbol];
    if (typeof key !== "object" || !key) throw new Error("Invalid queue key");
    const queued = { [queueOptionsSymbol]: key };
    now = 105;
    queue.push(queued);
    now = 125;
    expect(queue.shift()).toBe(queued);
    now = 175;
    return {
      kind: "detected",
      detections: [],
      timing: {
        readMs: 0,
        decodeMs: 0,
        preprocessMs: 5,
        inferenceMs: 20,
        postprocessMs: 1,
        workerMs: 40,
      },
    };
  });
  try {
    const result = await pool.submit({
      kind: "detect",
      frame: { width: 1, height: 1, rgb: new Uint8Array(3) },
    });
    expect(result).toMatchObject({
      timing: { queueMs: 20, workerDispatchMs: 15 },
    });
  } finally {
    clock.mockRestore();
    await pool.close();
  }
});
