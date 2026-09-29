import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { queueOptionsSymbol, type Piscina } from "piscina";
import type run from "../../src/perception/compute/inference-worker";
import { resolveComputeBudget } from "../../src/perception/compute/budget";

const detected = {
  kind: "detected" as const,
  detections: [],
  timing: {
    readMs: 0,
    decodeMs: 0,
    preprocessMs: 1,
    inferenceMs: 2,
    postprocessMs: 1,
    workerMs: 4,
  },
};
function metadata(id: number) {
  return {
    input: {
      name: "images",
      isTensor: true as const,
      type: "float32" as const,
      shape: [1, 3, 416, 416],
    },
    output: {
      name: "output0",
      isTensor: true as const,
      type: "float32" as const,
      shape: [1, 9, 3549],
    },
    provider: "cpu" as const,
    sharpConcurrency: 1,
    intraOpNumThreads: 1 as const,
    workerThreadId: id,
    modelPath: "/model",
    sha256: "a".repeat(64),
  };
}
class WorkerPool extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
  run = mock<
    Piscina<Parameters<typeof run>[0], Awaited<ReturnType<typeof run>>>["run"]
  >(async (task) => {
    if (task.kind === "initialize")
      return { kind: "initialized", metadata: metadata(this.id) };
    if (task.kind === "close") return { kind: "closed" };
    return detected;
  });
  close = mock(async () => {});
}
const original = { ...(await import("piscina")) };
const workers: WorkerPool[] = [];
const constructor = mock(function (
  _options: ConstructorParameters<typeof original.Piscina>[0],
) {
  const worker = new WorkerPool(workers.length + 1);
  workers.push(worker);
  return worker;
});
await mock.module("piscina", () => ({ ...original, Piscina: constructor }));
afterAll(async () => {
  await mock.module("piscina", () => original);
});
beforeEach(() => {
  workers.length = 0;
  constructor.mockClear();
});
const { createInferencePool } =
  await import("../../src/perception/compute/inference-pool");
const frame = { width: 1, height: 1, rgb: new Uint8Array(3) };
function make(count = 2) {
  return createInferencePool(
    (error) => {
      throw error;
    },
    resolveComputeBudget(1, count),
  );
}

test("initializes and releases every distinct model owner", async () => {
  const pool = make(3);
  const result = await pool.submit({ kind: "initialize" });
  expect(result).toMatchObject({
    kind: "initialized",
    metadata: { workerThreadIds: [1, 2, 3] },
  });
  await pool.close();
  for (const worker of workers) {
    expect(worker.run.mock.calls.map(([task]) => task.kind)).toEqual([
      "initialize",
      "close",
    ]);
    expect(worker.close).toHaveBeenCalledTimes(1);
  }
});
test("two workers admit overlapping tasks with one globally bounded pending image", async () => {
  const pool = make();
  await pool.submit({ kind: "initialize" });
  const first = Promise.withResolvers<typeof detected>(),
    second = Promise.withResolvers<typeof detected>();
  workers[0]!.run.mockImplementationOnce(() => first.promise);
  workers[1]!.run.mockImplementationOnce(() => second.promise);
  const a = pool.submit({ kind: "detect", frame });
  const b = pool.submit({ kind: "detect", frame });
  expect(pool.available).toBe(false);
  const queued = pool.submit({
    kind: "detect_image",
    image: { path: "/image" },
  });
  await expect(pool.submit({ kind: "detect", frame })).rejects.toMatchObject({
    code: "busy",
  });
  first.resolve(detected);
  second.resolve(detected);
  await Promise.all([a, b, queued]);
  expect(pool.available).toBe(true);
  await pool.close();
});
test("close drains all workers before any native session release", async () => {
  const pool = make();
  await pool.submit({ kind: "initialize" });
  const pending = Promise.withResolvers<typeof detected>();
  workers[1]!.run.mockImplementationOnce(() => pending.promise);
  const a = pool.submit({ kind: "detect", frame });
  const b = pool.submit({ kind: "detect", frame });
  const closing = pool.close();
  try {
    expect(pool.close()).toBe(closing);
    await a;
    // Give an incorrectly early release a chance to reach the worker boundary.
    await new Promise((resolve) => setImmediate(resolve));
    for (const worker of workers) {
      expect(
        worker.run.mock.calls.some(([task]) => task.kind === "close"),
      ).toBe(false);
      expect(worker.close).not.toHaveBeenCalled();
    }
    pending.resolve(detected);
    await b;
    await closing;
    for (const worker of workers) {
      expect(
        worker.run.mock.calls.filter(([task]) => task.kind === "close"),
      ).toHaveLength(1);
      expect(worker.close).toHaveBeenCalledTimes(1);
    }
  } finally {
    pending.resolve(detected);
    await Promise.all([a, b, closing]);
  }
});
test("one failed initialization prevents readiness and preserves its cause", async () => {
  const pool = make();
  workers[1]!.run.mockRejectedValueOnce(new Error("second model failed"));
  await expect(pool.submit({ kind: "initialize" })).rejects.toThrow(
    "second model failed",
  );
  await expect(pool.submit({ kind: "detect", frame })).rejects.toThrow(
    "second model failed",
  );
});
test("release failure never forcibly terminates a native worker thread", async () => {
  const pool = make();
  await pool.submit({ kind: "initialize" });
  workers[0]!.run.mockRejectedValueOnce(new Error("release failed"));
  await expect(pool.close()).rejects.toThrow("release failed");
  expect(workers[0]!.close).not.toHaveBeenCalled();
});
test("ready cameras reserve free slots and pixel transfer waits for admission notification", async () => {
  const pool = make();
  await pool.submit({ kind: "initialize" });
  const unsubscribe = pool.subscribeAvailable(
    () => {},
    () => true,
  );
  await expect(pool.submit({ kind: "detect", frame })).rejects.toMatchObject({
    code: "busy",
  });
  let admitted = false;
  const pixels = new Uint8Array([1, 2, 3]);
  workers[0]!.run.mockImplementationOnce(async (task, options) => {
    expect(admitted).toBe(true);
    expect(options?.transferList).toEqual([pixels.buffer]);
    structuredClone(task, { transfer: options?.transferList ?? [] });
    return detected;
  });
  await pool.submit(
    { kind: "detect", frame: { ...frame, rgb: pixels } },
    async () => {
      admitted = true;
    },
  );
  expect(pixels.byteLength).toBe(0);
  unsubscribe();
  await pool.close();
});
test("image errors retain their code and do not poison the shared pool", async () => {
  const pool = make();
  await pool.submit({ kind: "initialize" });
  workers[0]!.run.mockResolvedValueOnce({
    kind: "image_failed",
    code: "invalid_image",
    message: "bad image",
    stack: undefined,
  });
  await expect(
    pool.submit({ kind: "detect_image", image: { path: "/bad" } }),
  ).rejects.toMatchObject({ code: "invalid_image" });
  expect(pool.available).toBe(true);
  await pool.close();
});

test("a worker error invalidates the shared admission gate", async () => {
  const failure = mock(() => {});
  const pool = createInferencePool(failure, resolveComputeBudget(1, 2));
  await pool.submit({ kind: "initialize" });
  const error = new Error("native worker failed");
  workers[1]!.emit("error", error);
  expect(failure).toHaveBeenCalledWith(error);
  expect(pool.available).toBe(false);
  await expect(pool.submit({ kind: "detect", frame })).rejects.toBe(error);
  await expect(pool.close()).rejects.toBe(error);
});

test("worker-local queue time remains separate from worker dispatch overhead", async () => {
  const pool = make(1);
  await pool.submit({ kind: "initialize" });
  let now = 100;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const queue = constructor.mock.calls[0]?.[0]?.taskQueue;
  if (!queue) throw new Error("Missing queue");
  workers[0]!.run.mockImplementationOnce(async (task) => {
    if (!(queueOptionsSymbol in task)) throw new Error("Missing queue key");
    const key = task[queueOptionsSymbol];
    if (typeof key !== "object" || !key) throw new Error("Invalid queue key");
    const queued = { [queueOptionsSymbol]: key };
    now = 105;
    queue.push(queued);
    now = 125;
    queue.shift();
    now = 175;
    return { ...detected, timing: { ...detected.timing, workerMs: 40 } };
  });
  try {
    expect(await pool.submit({ kind: "detect", frame })).toMatchObject({
      timing: { queueMs: 20, workerDispatchMs: 15 },
    });
  } finally {
    clock.mockRestore();
    await pool.close();
  }
});

test("the shared pending task goes to the next idle worker instead of waiting behind a slower one", async () => {
  const pool = make(2);
  await pool.submit({ kind: "initialize" });
  const slow = Promise.withResolvers<typeof detected>(),
    fast = Promise.withResolvers<typeof detected>();
  workers[0]!.run.mockImplementationOnce(() => slow.promise);
  workers[1]!.run.mockImplementationOnce(() => fast.promise);
  const a = pool.submit({ kind: "detect", frame }),
    b = pool.submit({ kind: "detect", frame });
  const pending = pool.submit({ kind: "detect", frame });
  fast.resolve(detected);
  await b;
  await pending;
  expect(workers[0]!.run).toHaveBeenCalledTimes(2);
  expect(workers[1]!.run).toHaveBeenCalledTimes(3);
  slow.resolve(detected);
  await a;
  await pool.close();
});
