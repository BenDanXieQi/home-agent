import { inferenceRequest } from "../../src/perception/compute/inference-protocol";
import { expect, test, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { z } from "zod";
import { createInferenceProcess } from "../../src/perception/compute/inference-process";
import { createIdentityProcess } from "../../src/perception/identity/process";
import { identityConfigSchema } from "../../src/perception/identity/config";

function nativeBoundary() {
  const child = new childProcess.ChildProcess();
  Object.defineProperty(child, "pid", { value: 2_000_000_000 });
  Object.defineProperty(child, "stderr", { value: null });
  Object.defineProperty(child, "send", {
    configurable: true,
    writable: true,
    value: () => true,
  });
  const send = spyOn(child, "send");
  const kill = spyOn(child, "kill").mockImplementation(() => true);
  const fork = spyOn(childProcess, "fork").mockImplementation(() => child);
  const messages = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ready") }),
    z.object({ kind: z.literal("result"), id: z.string() }),
  ]);
  const input = z.object({ id: z.string() });
  const worker = createInferenceProcess<
    z.infer<typeof input>,
    undefined,
    Extract<z.infer<typeof messages>, { kind: "result" }>
  >({
    entry: new URL("file:///native-inference-fixture"),
    input,
    initializeTimeoutMs: 1000,
    closeTimeoutMs: 20,
    matches: (job, result) => job.id === result.id,
    decode(message) {
      const parsed = messages.parse(message);
      return parsed.kind === "ready"
        ? { kind: "ready", value: undefined }
        : { kind: "result", value: parsed };
    },
  });
  return {
    child,
    worker,
    send,
    kill,
    async close() {
      child.emit("exit", 0, null);
      await worker.close();
      send.mockRestore();
      kill.mockRestore();
      fork.mockRestore();
    },
  };
}

test("native request timeout retires the child and confirmed exit makes cleanup safe to retry", async () => {
  const native = nativeBoundary();
  try {
    native.child.emit("message", {
      requestId: null,
      message: { kind: "ready" },
    });
    await native.worker.initialize();
    await expect(native.worker.request({ id: "frame" }, 1)).rejects.toThrow(
      "timed out",
    );
    expect(native.kill).toHaveBeenCalled();
    await expect(native.worker.close()).rejects.toThrow("exit unconfirmed");
    native.child.emit("exit", null, "SIGKILL");
    const calls = native.kill.mock.calls.length;
    await native.worker.close();
    expect(native.kill.mock.calls.length).toBe(calls);
    await expect(
      native.worker.request({ id: "replacement" }, 10),
    ).rejects.toThrow();
  } finally {
    await native.close();
  }
});

test("wrong native result identity and synchronous IPC failure cannot leave requests hanging", async () => {
  for (const synchronous of [false, true]) {
    const native = nativeBoundary();
    try {
      native.child.emit("message", {
        requestId: null,
        message: { kind: "ready" },
      });
      await native.worker.initialize();
      if (synchronous)
        native.send.mockImplementation(() => {
          throw new Error("IPC unavailable");
        });
      const request = native.worker.request({ id: "frame" }, 1000);
      if (!synchronous)
        native.child.emit("message", {
          requestId: crypto.randomUUID(),
          message: { kind: "result", id: "other-frame" },
        });
      await expect(request).rejects.toThrow(
        synchronous ? "IPC unavailable" : "result identity",
      );
      expect(native.worker.status.ready).toBe(false);
      expect(native.kill).toHaveBeenCalled();
    } finally {
      await native.close();
    }
  }
});

test("a model-level identity preparation failure keeps its native process usable and closes cleanly", async () => {
  const controller = new AbortController();
  const model = await createIdentityProcess(
    identityConfigSchema.parse({
      modelDirectory: "/nonexistent-identity-models",
    }),
    controller.signal,
  );
  const pid = model.metadata.processId!;
  try {
    const prepared = await model.prepare(["human"]);
    expect(prepared.available).toEqual([]);
    expect(prepared.failures).toHaveLength(1);
    expect(model.status("human").status).toBe("unavailable");
    expect(model.error).toBeUndefined();
    await model.prepare(["cat"]);
    expect(model.error).toBeUndefined();
  } finally {
    await model.close();
  }
  expect(() => process.kill(pid, 0)).toThrow();
}, 10000);

test("a duplicate response from the previous request cannot satisfy a new request", async () => {
  const native = nativeBoundary();
  try {
    native.child.emit("message", {
      requestId: null,
      message: { kind: "ready" },
    });
    await native.worker.initialize();
    const first = native.worker.request({ id: "same-frame" }, 1000);
    const requestId = inferenceRequest(z.object({ id: z.string() })).parse(
      native.send.mock.calls[0]![0],
    ).requestId;
    const response = {
      requestId,
      message: { kind: "result", id: "same-frame" },
    };
    native.child.emit("message", response);
    await expect(first).resolves.toEqual({ kind: "result", id: "same-frame" });
    const next = native.worker.request({ id: "same-frame" }, 1000);
    native.child.emit("message", response);
    await expect(next).rejects.toThrow("result identity");
  } finally {
    await native.close();
  }
});
