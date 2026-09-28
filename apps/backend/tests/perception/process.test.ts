import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

class Child extends EventEmitter {
  pid: number | undefined = 12345;
  stderr = new EventEmitter();
  messages: unknown[] = [];
  kills: string[] = [];
  send(message: unknown, callback: (error: Error | null) => void) {
    this.messages.push(message);
    callback(null);
  }
  kill(signal: string) {
    this.kills.push(signal);
    return true;
  }
}
let child: Child;
const original = { ...(await import("node:child_process")) };
const fork = mock(() => child);
await mock.module("node:child_process", () => ({ ...original, fork }));
const { createDetectionProcess } =
  await import("../../src/perception/compute/process");
afterAll(async () => {
  await mock.module("node:child_process", () => original);
});
beforeEach(() => {
  child = new Child();
  fork.mockClear();
});
function start() {
  const process = createDetectionProcess();
  process.events.on("error", () => {});
  return process;
}

test("SIGKILL request is not exit confirmation; destroy is idempotent", async () => {
  const process = start();
  let done = false;
  const destruction = process.destroy();
  expect(process.destroy()).toBe(destruction);
  void destruction.then(() => {
    done = true;
  });
  await delay(1);
  expect(done).toBe(false);
  expect(child.kills).toEqual(["SIGKILL"]);
  child.emit("exit", null, "SIGKILL");
  await destruction;
  expect(done).toBe(true);
});

test("pending calls fail on process death and later results are ignored", async () => {
  const process = start();
  child.emit("message", { kind: "ready" });
  const task = process
    .submit({ kind: "close" })
    .catch((error: unknown) => error);
  await delay(1);
  child.emit("exit", null, "SIGABRT");
  child.emit("message", {
    kind: "result",
    id: 1,
    result: { kind: "closed" },
    processingMs: 0,
  });
  expect(await task).toBeInstanceOf(Error);
  await process.destroy();
  expect(child.kills).toHaveLength(0);
});

test("IPC disconnect does not stand in for process exit", async () => {
  const process = start();
  child.emit("message", { kind: "ready" });
  const task = process
    .submit({ kind: "close" })
    .catch((error: unknown) => error);
  await delay(1);
  child.emit("disconnect");
  expect(await task).toBeInstanceOf(Error);
  let done = false;
  const destruction = process.destroy().then(() => {
    done = true;
  });
  await delay(1);
  expect(done).toBe(false);
  child.emit("exit", 1, null);
  await destruction;
});

test("failed spawn rejects readiness without waiting for a nonexistent process exit", async () => {
  const process = start();
  child.pid = undefined;
  const task = process
    .submit({ kind: "close" })
    .catch((error: unknown) => error);
  child.emit("error", new Error("spawn failed"));
  expect(await task).toBeInstanceOf(Error);
  await process.destroy();
  expect(child.kills).toHaveLength(0);
});

test("native child error response fails its task without accepting malformed output", async () => {
  const process = start();
  child.emit("message", { kind: "ready" });
  const task = process
    .submit({ kind: "close" })
    .catch((error: unknown) => error);
  await delay(1);
  child.emit("message", { kind: "error", id: 1, message: "session failed" });
  expect(await task).toMatchObject({ message: "session failed" });
  const invalid = process
    .submit({ kind: "close" })
    .catch((error: unknown) => error);
  await delay(1);
  child.emit("message", {
    kind: "result",
    id: 2,
    result: { kind: "incorrect" },
    processingMs: 0,
  });
  expect(await invalid).toMatchObject({
    message: "Invalid detection process response",
  });
  const destruction = process.destroy();
  child.emit("exit", 0, null);
  await destruction;
});

test("image errors preserve their recoverable classification over IPC", async () => {
  const process = start();
  child.emit("message", { kind: "ready" });
  const task = process
    .submit({ kind: "detect_image", image: { path: "/bad.png" } })
    .catch((error: unknown) => error);
  await delay(1);
  child.emit("message", {
    kind: "error",
    id: 1,
    code: "invalid_image",
    message: "Cannot decode image: unsupported format",
  });
  expect(await task).toMatchObject({
    code: "invalid_image",
    message: "Cannot decode image: unsupported format",
  });
  const destruction = process.destroy();
  child.emit("exit", 0, null);
  await destruction;
});

test.each(["starting", "idle"] as const)(
  "fatal %s failure preserves the worker cause and stack",
  async (state) => {
    const process = start();
    const errors: Error[] = [];
    process.events.on("error", (error: Error) => errors.push(error));
    if (state === "idle") child.emit("message", { kind: "ready" });
    const task = process
      .submit({ kind: "initialize", modelPath: "model.onnx" })
      .catch((error: unknown) => error);
    await delay(1);
    child.emit("message", {
      kind: "fatal",
      message: "Invalid model: unsupported tensor shape",
      stack: "Error: unsupported tensor shape\n    at createDetector",
    });
    expect(await task).toMatchObject({
      message: "Invalid model: unsupported tensor shape",
      stack: "Error: unsupported tensor shape\n    at createDetector",
    });
    expect(errors[0]?.message).toContain("unsupported tensor shape");
    const destruction = process.destroy();
    child.emit("exit", 1, null);
    await destruction;
  },
);

test("process quota survives disconnect and releases only on actual exit", async () => {
  const current = start();
  expect(() => start()).toThrow("budget exhausted");
  child.emit("disconnect");
  expect(() => start()).toThrow("budget exhausted");
  const destruction = current.destroy();
  expect(() => start()).toThrow("budget exhausted");
  child.emit("exit", null, "SIGKILL");
  await destruction;
  child = new Child();
  const replacement = start();
  const done = replacement.destroy();
  child.emit("exit", 0, null);
  await done;
});

test.each(["Uint8Array", "Buffer"] as const)(
  "IPC isolates the visible pixel range of %s",
  async (kind) => {
    const process = start();
    child.emit("message", { kind: "ready" });
    const backing =
      kind === "Buffer"
        ? Buffer.alloc(1024 * 1024, 99)
        : new Uint8Array(1024 * 1024).fill(99);
    const rgb = backing.subarray(10, 13);
    const result = process.submit({
      kind: "detect",
      frame: { width: 1, height: 1, rgb },
    });
    await delay(1);
    expect(child.messages).toHaveLength(1);
    const { requestSchema } =
      await import("../../src/perception/compute/protocol");
    const request = requestSchema.parse(child.messages[0]);
    if (request.task.kind !== "detect")
      throw new Error("Expected detection task");
    expect(request.task.frame.rgb.buffer.byteLength).toBe(3);
    expect(backing.byteLength).toBe(1024 * 1024);
    expect(request.task.frame.rgb).toEqual(new Uint8Array([99, 99, 99]));
    expect(rgb.buffer).toBe(backing.buffer);
    child.emit("message", {
      kind: "result",
      id: request.id,
      result: { kind: "closed" },
      processingMs: 0,
    });
    await result;
    const done = process.destroy();
    child.emit("exit", 0, null);
    await done;
  },
);

test("IPC timing excludes child processing from the round trip", async () => {
  const process = start();
  child.emit("message", { kind: "ready" });
  let now = 5000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const pixels = new Uint8Array(16).subarray(4, 7);
    const detection = process.submit({
      kind: "detect",
      frame: { width: 1, height: 1, rgb: pixels },
    });
    await Promise.resolve();
    expect(child.messages).toHaveLength(1);
    now += 180;
    child.emit("message", {
      kind: "result",
      id: 1,
      processingMs: 130,
      result: {
        kind: "detected",
        detections: [],
        timing: {
          readMs: 0,
          decodeMs: 0,
          annotationMs: 0,
          preprocessMs: 10,
          inferenceMs: 20,
          postprocessMs: 4,
          queueMs: 90,
          workerDispatchMs: 2,
        },
      },
    });
    const result = await detection;
    if (result.kind !== "detected") throw new Error("Expected detection");
    expect(result.timing).toMatchObject({
      ipcRoundTripMs: 50,
    });
  } finally {
    clock.mockRestore();
    const destruction = process.destroy();
    child.emit("exit", 0, null);
    await destruction;
  }
});
