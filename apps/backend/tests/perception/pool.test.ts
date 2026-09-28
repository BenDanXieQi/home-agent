import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { z } from "zod";
import type { taskSchema } from "../../src/perception/compute/protocol";
import { ImageProcessingError } from "../../src/perception/detection/image-request";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const result = {
  kind: "detected",
  detections: [],
  timing: {
    readMs: 0,
    decodeMs: 0,
    annotationMs: 0,
    preprocessMs: 1,
    inferenceMs: 1,
    postprocessMs: 1,
    queueMs: 0,
    workerDispatchMs: 0,
    ipcRoundTripMs: 0,
  },
};
const initialized = {
  kind: "initialized",
  metadata: {
    provider: "cpu",
    workerThreadId: 1,
    modelPath: "/local/model.onnx",
    sha256: "a".repeat(64),
  },
};
const instances: FakeProcess[] = [];
let initializeTask: () => Promise<unknown>;
let detectTask: (
  task: Extract<
    z.infer<typeof taskSchema>,
    { kind: "detect" | "detect_image" }
  >,
) => Promise<unknown>;
let releaseTask: () => Promise<unknown>;
let destroyPool: () => Promise<void>;

class FakeProcess extends EventEmitter {
  readonly events = this;
  readonly failure = new AbortController();
  destroyed = 0;
  private destruction: Promise<void> | undefined;
  released = 0;
  constructor() {
    super();
    instances.push(this);
  }
  submit(task: z.infer<typeof taskSchema>) {
    if (task.kind === "initialize") return initializeTask();
    if (task.kind === "close") {
      this.released++;
      return releaseTask();
    }
    return detectTask(task);
  }
  destroy() {
    this.destruction ??= (async () => {
      this.destroyed++;
      await destroyPool();
    })();
    return this.destruction;
  }
}
const nativeProcess = {
  ...(await import("../../src/perception/compute/process")),
};
await mock.module("../../src/perception/compute/process", () => ({
  createDetectionProcess: () => new FakeProcess(),
}));
afterAll(async () => {
  await mock.module(
    "../../src/perception/compute/process",
    () => nativeProcess,
  );
});
const { createDetectionPool } =
  await import("../../src/perception/compute/pool");
const frame = { width: 1, height: 1, rgb: new Uint8Array(3) };
const options = {
  initializeTimeoutMs: 30,
  taskTimeoutMs: 30,
  closeTimeoutMs: 100,
  recoveryDelayMs: 0,
  maxRestarts: 2,
};
const pools: Awaited<ReturnType<typeof createDetectionPool>>[] = [];
async function create(overrides: Partial<typeof options> = {}) {
  const pool = await createDetectionPool("/local/model.onnx", {
    ...options,
    ...overrides,
  });
  pools.push(pool);
  return pool;
}
async function waitForStatus(
  pool: Awaited<ReturnType<typeof create>>,
  status: ReturnType<Awaited<ReturnType<typeof create>>["getStatus"]>["status"],
) {
  const end = performance.now() + 1000;
  while (pool.getStatus().status !== status && performance.now() < end)
    await delay(1);
  expect(pool.getStatus().status).toBe(status);
}

beforeEach(() => {
  instances.length = 0;
  pools.length = 0;
  initializeTask = async () => initialized;
  detectTask = async () => result;
  releaseTask = async () => ({ kind: "closed" });
  destroyPool = async () => {};
});
afterEach(async () => {
  await Promise.allSettled(pools.map((pool) => pool.close()));
});

describe("detection pool lifecycle", () => {
  test("drains accepted work before release; close is idempotent and rejects new work", async () => {
    const pending = Promise.withResolvers<unknown>();
    detectTask = () => pending.promise;
    const pool = await create();
    const detection = pool.detect(frame);
    const first = pool.close();
    expect(pool.close()).toBe(first);
    await expect(pool.detect(frame)).rejects.toMatchObject({ code: "closed" });
    expect(instances[0]!.released).toBe(0);
    pending.resolve(result);
    await detection;
    await first;
    expect(instances[0]!.released).toBe(1);
    expect(instances[0]!.destroyed).toBe(1);
    expect(pool.getStatus().status).toBe("closed");
  });

  test("rejects overflow without treating backpressure as worker failure", async () => {
    const pending = Promise.withResolvers<unknown>();
    detectTask = () => pending.promise;
    const pool = await create();
    const accepted = [pool.detect(frame), pool.detect(frame)];
    await expect(pool.detect(frame)).rejects.toMatchObject({ code: "busy" });
    pending.resolve(result);
    await Promise.all(accepted);
    expect(pool.getStatus().restarts).toBe(0);
  });

  test("invalid input never enters the pool or consumes recovery budget", async () => {
    const pool = await create();
    await expect(
      pool.detect({ ...frame, rgb: new Uint8Array(0) }),
    ).rejects.toBeDefined();
    expect(pool.getStatus().status).toBe("ready");
    expect(pool.getStatus().restarts).toBe(0);
    await expect(
      pool.detectImage({ path: "x".repeat(4096) }),
    ).rejects.toBeDefined();
    expect(pool.getStatus()).toMatchObject({
      status: "ready",
      restarts: 0,
      activeRequests: 0,
    });
  });

  test("image and raw tasks share admission while image paths hold no parent RGB", async () => {
    const ready = Promise.withResolvers<void>();
    detectTask = async (task) => {
      await ready.promise;
      return task.kind === "detect_image"
        ? {
            ...result,
            kind: "image_detected",
            imagePath: task.image.path,
            inputSha256: "b".repeat(64),
            width: 1,
            height: 1,
          }
        : result;
    };
    const pool = await create();
    const image = pool.detectImage({ path: "/local/image.png" });
    const raw = pool.detect(frame);
    expect(pool.getStatus()).toMatchObject({
      activeRequests: 2,
      activeImageRequests: 1,
      activeRgbBytes: 3,
    });
    await expect(
      pool.detectImage({ path: "/local/extra.png" }),
    ).rejects.toMatchObject({ code: "busy" });
    ready.resolve();
    expect((await image).kind).toBe("image_detected");
    expect((await raw).kind).toBe("detected");
    expect(pool.getStatus()).toMatchObject({
      activeRequests: 0,
      activeImageRequests: 0,
      activeRgbBytes: 0,
      restarts: 0,
    });
  });

  test.each(["invalid_image", "output_failed"] as const)(
    "%s releases capacity without restarting the model and the next request succeeds",
    async (code) => {
      detectTask = async () => {
        throw new ImageProcessingError(code, "invalid image or output");
      };
      const pool = await create();
      await expect(
        pool.detectImage({ path: "/local/image.png" }),
      ).rejects.toMatchObject({ code });
      expect(pool.getStatus()).toMatchObject({
        status: "ready",
        restarts: 0,
        activeImageRequests: 0,
        activeRequests: 0,
      });
      detectTask = async () => result;
      expect((await pool.detect(frame)).kind).toBe("detected");
      expect(instances).toHaveLength(1);
    },
  );

  test("image timeout removes staging only after confirmed process exit", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "perception-image-timeout-"),
    );
    const started = Promise.withResolvers<string>();
    const exited = Promise.withResolvers<void>();
    destroyPool = () => exited.promise;
    detectTask = async (task) => {
      if (task.kind !== "detect_image" || !task.stagingPath)
        throw new Error("Expected staged image request");
      await writeFile(task.stagingPath, "writer still owns this file");
      started.resolve(task.stagingPath);
      return await new Promise(() => {});
    };
    try {
      const pool = await create({ closeTimeoutMs: 500, maxRestarts: 0 });
      const detection = pool.detectImage({
        path: "/local/image.png",
        outputPath: join(directory, "output.png"),
      });
      const stagingPath = await started.promise;
      await expect(detection).rejects.toMatchObject({ code: "timeout" });
      expect(await readFile(stagingPath, "utf8")).toBe(
        "writer still owns this file",
      );
      expect(instances[0]!.destroyed).toBe(1);
      exited.resolve();
      await waitForStatus(pool, "unavailable");
      await expect(readFile(stagingPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      exited.resolve();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("failed staging cleanup stops admission instead of accumulating output files", async () => {
    const files = { ...(await import("node:fs/promises")) };
    const directory = await mkdtemp(
      join(tmpdir(), "perception-image-cleanup-"),
    );
    let stagingPath = "";
    let denyCleanup = true;
    detectTask = async (task) => {
      if (task.kind !== "detect_image" || !task.stagingPath)
        throw new Error("Expected staged image request");
      stagingPath = task.stagingPath;
      await writeFile(stagingPath, "unremoved output");
      // A raw result cannot confirm completion of this image writer.
      return result;
    };
    await mock.module("node:fs/promises", () => ({
      ...files,
      unlink: async (...args: Parameters<typeof files.unlink>) => {
        if (denyCleanup && args[0] === stagingPath)
          throw new Error("Permission denied removing staged output");
        return await files.unlink(...args);
      },
    }));
    try {
      const pool = await create();
      await expect(
        pool.detectImage({
          path: "/local/image.png",
          outputPath: join(directory, "output.png"),
        }),
      ).rejects.toMatchObject({ code: "worker_failed" });
      await waitForStatus(pool, "unavailable");
      await expect(
        pool.detectImage({
          path: "/local/next.png",
          outputPath: join(directory, "next.png"),
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await files.readdir(directory)).toHaveLength(1);
      expect(pool.getStatus().lastError).toContain(
        "Unable to remove staged image",
      );
      denyCleanup = false;
      await pool.close();
      expect(await files.readdir(directory)).toHaveLength(0);
    } finally {
      denyCleanup = false;
      await mock.module("node:fs/promises", () => files);
      await files.rm(directory, { recursive: true, force: true });
    }
  });

  test("a task timeout rejects the old result and rebuilds without replaying it", async () => {
    const late = Promise.withResolvers<unknown>();
    detectTask = () => late.promise;
    const pool = await create();
    await expect(pool.detect(frame)).rejects.toMatchObject({ code: "timeout" });
    const replacementDetect = mock(async () => result);
    detectTask = replacementDetect;
    await waitForStatus(pool, "ready");
    expect(replacementDetect).not.toHaveBeenCalled();
    late.resolve({ ...result, detections: [{ stale: true }] });
    expect((await pool.detect(frame)).detections).toEqual([]);
    expect(replacementDetect).toHaveBeenCalledTimes(1);
    expect(pool.getStatus().restarts).toBe(1);
    expect(instances[0]!.destroyed).toBe(1);
  });

  test("successful recovery exposes the replacement metadata", async () => {
    const pool = await create();
    expect(pool.metadata.workerThreadId).toBe(1);
    initializeTask = async () => ({
      ...initialized,
      metadata: { ...initialized.metadata, workerThreadId: 2 },
    });
    instances[0]!.emit("error", new Error("worker failed"));
    await waitForStatus(pool, "ready");
    expect(pool.metadata.workerThreadId).toBe(2);
  });

  test("status retains the failure cause when recovery is unavailable", async () => {
    const pool = await create({ maxRestarts: 0 });
    instances[0]!.emit(
      "error",
      new Error("model initialization failed", {
        cause: new Error("unsupported tensor shape"),
      }),
    );
    await waitForStatus(pool, "unavailable");
    expect(pool.getStatus().lastError).toContain("unsupported tensor shape");
    expect(pool.getStatus().lastError).toContain("model initialization failed");
  });

  test("pool-level errors reject all old tasks and exhaust a finite restart budget", async () => {
    const pool = await create({ maxRestarts: 1 });
    const late = Promise.withResolvers<unknown>();
    detectTask = () => late.promise;
    const first = pool.detect(frame);
    const second = pool.detect(frame);
    const firstError = first.catch((error: unknown) => error);
    const secondError = second.catch((error: unknown) => error);
    instances[0]!.emit("error", new Error("worker crashed"));
    expect(await firstError).toMatchObject({ code: "worker_failed" });
    expect(await secondError).toMatchObject({ code: "worker_failed" });
    await waitForStatus(pool, "ready");
    late.resolve(result);
    instances[1]!.emit("error", new Error("worker crashed again"));
    await waitForStatus(pool, "unavailable");
    await expect(pool.detect(frame)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(instances.length).toBe(2);
  });

  test("task errors are reported and failed replacement initialization consumes the budget", async () => {
    const pool = await create();
    detectTask = async () => {
      throw new Error("native inference rejected");
    };
    initializeTask = async () => {
      throw new Error("model reload failed");
    };
    await expect(pool.detect(frame)).rejects.toMatchObject({
      code: "worker_failed",
    });
    await waitForStatus(pool, "unavailable");
    expect(instances.length).toBe(3);
    expect(pool.getStatus().restarts).toBe(2);
    expect(instances.every((instance) => instance.destroyed === 1)).toBe(true);
  });

  test("close during replacement initialization cancels loading and prevents another retry", async () => {
    const pool = await create({ initializeTimeoutMs: 1000 });
    initializeTask = () => new Promise(() => {});
    instances[0]!.emit("error", new Error("worker failed"));
    const end = performance.now() + 1000;
    while (instances.length < 2 && performance.now() < end) await delay(1);
    expect(instances.length).toBe(2);
    await pool.close();
    expect(instances.length).toBe(2);
    expect(instances[1]!.destroyed).toBe(1);
    expect(pool.getStatus().status).toBe("closed");
  });

  test("initialization has a deadline and destroys the failed worker", async () => {
    initializeTask = () => new Promise(() => {});
    await expect(create()).rejects.toMatchObject({ code: "timeout" });
    expect(instances[0]!.destroyed).toBe(1);
  });

  test("close bounds a stuck session release and then destroys the worker", async () => {
    releaseTask = () => new Promise(() => {});
    const pool = await create();
    await expect(pool.close()).rejects.toMatchObject({ code: "timeout" });
    expect(instances[0]!.destroyed).toBe(1);
    expect(pool.getStatus().status).toBe("closed");
  });

  test("close bounds in-flight detection and rejects it when retiring", async () => {
    detectTask = () => new Promise(() => {});
    const pool = await create({ taskTimeoutMs: 1000 });
    const detection = pool.detect(frame).catch((error: unknown) => error);
    await expect(pool.close()).rejects.toMatchObject({ code: "timeout" });
    expect(await detection).toMatchObject({ code: "closed" });
    expect(instances[0]!.released).toBe(0);
    expect(instances[0]!.destroyed).toBe(1);
  });

  test("unconfirmed native termination prevents replacement and close reports failure", async () => {
    destroyPool = () => new Promise(() => {});
    const pool = await create();
    instances[0]!.emit("error", new Error("native failure"));
    await waitForStatus(pool, "unavailable");
    expect(instances.length).toBe(1);
    await expect(pool.close()).rejects.toMatchObject({ code: "timeout" });
  });

  test("close cancels recovery backoff without starting another worker", async () => {
    const pool = await create({ recoveryDelayMs: 1000 });
    instances[0]!.emit("error", new Error("idle failure"));
    await pool.close();
    expect(instances.length).toBe(1);
    expect(pool.getStatus().status).toBe("closed");
  });
});
