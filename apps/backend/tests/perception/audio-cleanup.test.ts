import { test, expect, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { createAudioProcess } from "../../src/perception/audio/process";

// Model an OS boundary that acknowledges termination late. A user retry must
// recover ownership after confirmation, without signalling a reused group id.
test("a late OS exit confirmation allows a previously timed-out audio shutdown to finish", async () => {
  const child = new childProcess.ChildProcess();
  const pid = 2_000_000_000;
  Object.defineProperty(child, "stderr", { value: null });
  Object.defineProperty(child, "pid", { value: pid });
  Object.defineProperty(child, "connected", { value: true });
  const send = spyOn(child, "send").mockImplementation(() => true);
  const fork = spyOn(childProcess, "fork").mockImplementation(() => child);
  const originalKill = process.kill.bind(process);
  let released = false;
  const kill = spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target !== -pid) return originalKill(target, signal);
    if (released)
      throw new Error(
        "The old process group no longer belongs to this operation",
      );
    return true;
  });
  try {
    const runtime = createAudioProcess({
      track() {},
      failure(error) {
        throw new Error(error);
      },
    });
    child.emit("message", { kind: "ready", model: null });
    const closing = runtime.close();
    child.emit("message", { kind: "closed" });
    await expect(closing).rejects.toThrow("Audio process exit unconfirmed");
    released = true;
    child.emit("exit", 0, null);
    await expect(runtime.close()).resolves.toBeUndefined();
  } finally {
    send.mockRestore();
    fork.mockRestore();
    kill.mockRestore();
  }
}, 8000);
