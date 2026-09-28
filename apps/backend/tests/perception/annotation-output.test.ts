import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { z } from "zod";
import type { taskSchema } from "../../src/perception/compute/protocol";

const files = { ...(await import("node:fs/promises")) };
let publish = files.rename;
await mock.module("node:fs/promises", () => ({
  ...files,
  rename: (...args: Parameters<typeof files.rename>) => publish(...args),
}));
const nativeProcess = {
  ...(await import("../../src/perception/compute/process")),
};
const raw = {
  kind: "detected" as const,
  detections: [],
  timing: {
    readMs: 0,
    decodeMs: 0,
    annotationMs: 0,
    preprocessMs: 0,
    inferenceMs: 0,
    postprocessMs: 0,
    queueMs: 0,
    workerDispatchMs: 0,
    ipcRoundTripMs: 0,
  },
};
let sequence = 0;
async function prepare(
  task: Extract<
    z.infer<typeof taskSchema>,
    { kind: "detect" | "detect_image" }
  >,
) {
  if (task.kind === "detect") return raw;
  if (task.stagingPath)
    await files.writeFile(task.stagingPath, `image-${++sequence}`);
  return {
    ...raw,
    kind: "image_detected" as const,
    imagePath: task.image.path,
    inputSha256: "a".repeat(64),
    width: 1,
    height: 1,
    stagedImage: task.stagingPath,
  };
}
let work: (task: Parameters<typeof prepare>[0]) => Promise<unknown> = prepare;
const processes: FakeProcess[] = [];
class FakeProcess extends EventEmitter {
  readonly events = this;
  readonly failure = new AbortController();
  destroyed = false;
  constructor() {
    super();
    processes.push(this);
  }
  submit(task: z.infer<typeof taskSchema>) {
    if (task.kind === "initialize")
      return Promise.resolve({
        kind: "initialized",
        metadata: { modelPath: "/model.onnx", sha256: "b".repeat(64) },
      });
    if (task.kind === "close") return Promise.resolve({ kind: "closed" });
    return work(task);
  }
  async destroy() {
    this.destroyed = true;
  }
}
await mock.module("../../src/perception/compute/process", () => ({
  createDetectionProcess: () => new FakeProcess(),
}));
const { createDetectionPool } =
  await import("../../src/perception/compute/pool");
const pools: Awaited<ReturnType<typeof createDetectionPool>>[] = [];
let directory: string;
let outputPath: string;
const frame = { width: 1, height: 1, rgb: new Uint8Array(3) };

async function create(
  overrides: NonNullable<Parameters<typeof createDetectionPool>[1]> = {},
) {
  const pool = await createDetectionPool("/model.onnx", {
    taskTimeoutMs: 500,
    closeTimeoutMs: 100,
    recoveryDelayMs: 0,
    maxRestarts: 0,
    ...overrides,
  });
  pools.push(pool);
  return pool;
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 500 && !check(); attempt++) await delay(1);
  expect(check()).toBe(true);
}
function holdPublication() {
  const pending = Promise.withResolvers<void>();
  publish = async (...args) => {
    await pending.promise;
    await files.rename(...args);
  };
  return pending.resolve;
}
beforeEach(async () => {
  directory = await files.mkdtemp(join(tmpdir(), "perception-annotation-"));
  outputPath = join(directory, "output.png");
  await files.writeFile(outputPath, "previous output");
  work = prepare;
  publish = files.rename;
  sequence = 0;
  processes.length = 0;
  pools.length = 0;
});
afterEach(async () => {
  await Promise.allSettled(pools.map((pool) => pool.close()));
  await files.rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await mock.module("node:fs/promises", () => files);
  await mock.module(
    "../../src/perception/compute/process",
    () => nativeProcess,
  );
});

test("a prepared image observed after its deadline never replaces the target", async () => {
  const pool = await create({ taskTimeoutMs: 50 });
  const started = performance.now();
  let now = started;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const rename = mock(publish);
  publish = rename;
  work = async (task) => {
    const result = await prepare(task);
    now = started + 51;
    return result;
  };
  try {
    await expect(
      pool.detectImage({ path: "/image.png", outputPath }),
    ).rejects.toMatchObject({ code: "timeout" });
    await until(() => pool.getStatus().status === "unavailable");
    expect(rename).not.toHaveBeenCalled();
    expect(await files.readFile(outputPath, "utf8")).toBe("previous output");
    expect(await files.readdir(directory)).toEqual(["output.png"]);
  } finally {
    clock.mockRestore();
  }
});

test("generation failure before acceptance discards the prepared image", async () => {
  const pool = await create();
  const prepared = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  work = async (task) => {
    if (task.kind === "detect") throw new Error("another task failed");
    const result = await prepare(task);
    prepared.resolve();
    await release.promise;
    return result;
  };
  const image = pool
    .detectImage({ path: "/image.png", outputPath })
    .catch((error: unknown) => error);
  await prepared.promise;
  await expect(pool.detect(frame)).rejects.toMatchObject({
    code: "worker_failed",
  });
  release.resolve();
  expect(await image).toMatchObject({ code: "worker_failed" });
  await until(() => pool.getStatus().status === "unavailable");
  expect(await files.readFile(outputPath, "utf8")).toBe("previous output");
  expect(await files.readdir(directory)).toEqual(["output.png"]);
});

test("generation failure after acceptance cannot cancel publication", async () => {
  const pool = await create();
  const finish = holdPublication();
  const image = pool.detectImage({ path: "/image.png", outputPath });
  try {
    await until(() => pool.getStatus().committingOutputs.length === 1);
    work = async () => {
      throw new Error("another task failed");
    };
    await expect(pool.detect(frame)).rejects.toMatchObject({
      code: "worker_failed",
    });
    await until(() => processes[0]!.destroyed);
    expect(await files.readFile(outputPath, "utf8")).toBe("previous output");
    finish();
    expect((await image).annotatedImage).toBe(outputPath);
    expect(await files.readFile(outputPath, "utf8")).toBe("image-1");
  } finally {
    finish();
    await Promise.allSettled([image]);
  }
});

test("unknown publication retains its slot and path until settlement", async () => {
  const pool = await create({ taskTimeoutMs: 30 });
  const finish = holdPublication();
  try {
    await expect(
      pool.detectImage({ path: "/image.png", outputPath }),
    ).rejects.toMatchObject({ code: "output_commit_unknown", outputPath });
    expect(pool.getStatus()).toMatchObject({
      status: "ready",
      activeRequests: 1,
      activeImageRequests: 1,
      committingOutputs: [outputPath],
    });
    await expect(
      pool.detectImage({ path: "/next.png", outputPath }),
    ).rejects.toMatchObject({ code: "busy" });
    const rawWork = Promise.withResolvers<typeof raw>();
    work = () => rawWork.promise;
    const second = pool.detect(frame);
    await expect(pool.detect(frame)).rejects.toMatchObject({ code: "busy" });
    rawWork.resolve(raw);
    await second;
    finish();
    await until(() => pool.getStatus().activeRequests === 0);
    expect(await files.readFile(outputPath, "utf8")).toBe("image-1");
    publish = files.rename;
    work = prepare;
    expect(
      (await pool.detectImage({ path: "/new.png", outputPath })).annotatedImage,
    ).toBe(outputPath);
    expect(await files.readFile(outputPath, "utf8")).toBe("image-2");
  } finally {
    finish();
    await until(() => pool.getStatus().activeRequests === 0);
  }
});

test("rename confirmed after the absolute deadline reports unknown even before the timer fires", async () => {
  const pool = await create({ taskTimeoutMs: 50 });
  const started = performance.now();
  let now = started;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  publish = async (...args) => {
    await files.rename(...args);
    now = started + 51;
  };
  try {
    await expect(
      pool.detectImage({ path: "/image.png", outputPath }),
    ).rejects.toMatchObject({ code: "output_commit_unknown", outputPath });
    expect(pool.getStatus()).toMatchObject({
      status: "ready",
      restarts: 0,
      activeRequests: 0,
      committingOutputs: [],
    });
    expect(await files.readFile(outputPath, "utf8")).toBe("image-1");
  } finally {
    clock.mockRestore();
  }
});

test("failed publication preserves the previous target and releases its reservation", async () => {
  const pool = await create();
  publish = async () => {
    throw new Error("rename denied");
  };
  await expect(
    pool.detectImage({ path: "/image.png", outputPath }),
  ).rejects.toMatchObject({ code: "output_failed", outputPath });
  expect(await files.readFile(outputPath, "utf8")).toBe("previous output");
  expect(await files.readdir(directory)).toEqual(["output.png"]);
  expect(pool.getStatus()).toMatchObject({
    status: "ready",
    restarts: 0,
    activeRequests: 0,
    committingOutputs: [],
  });
  publish = files.rename;
  await pool.detectImage({ path: "/next.png", outputPath });
  expect(await files.readFile(outputPath, "utf8")).toBe("image-2");
});

test("close reports an unconfirmed commit and prevents a replacement pool until it settles", async () => {
  const pool = await create({ taskTimeoutMs: 1000 });
  const finish = holdPublication();
  const image = pool
    .detectImage({ path: "/image.png", outputPath })
    .catch((error: unknown) => error);
  try {
    await until(() => pool.getStatus().committingOutputs.length === 1);
    await expect(pool.close()).rejects.toMatchObject({
      code: "output_commit_unknown",
      outputPath,
    });
    expect(await image).toMatchObject({
      code: "output_commit_unknown",
      outputPath,
    });
    expect(pool.getStatus()).toMatchObject({
      status: "unavailable",
      activeRequests: 1,
      committingOutputs: [outputPath],
    });
    expect(processes[0]!.destroyed).toBe(true);
    await expect(create()).rejects.toThrow("Pending annotated image outputs");
    expect(processes).toHaveLength(1);
    finish();
    await until(() => pool.getStatus().activeRequests === 0);
    const replacement = await create();
    publish = files.rename;
    await replacement.detectImage({ path: "/new.png", outputPath });
    expect(await files.readFile(outputPath, "utf8")).toBe("image-2");
  } finally {
    finish();
    await until(() => pool.getStatus().activeRequests === 0);
  }
});
