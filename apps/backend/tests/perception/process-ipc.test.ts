import { expect, mock, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { responseSchema } from "../../src/perception/compute/protocol";

test("real Bun IPC receives only the three visible bytes of a large Buffer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "perception-ipc-"));
  const fixture = join(directory, "receiver.ts");
  await writeFile(
    fixture,
    `
    process.on("message", ({ id, task }) => {
      const rgb = task.frame.rgb;
      process.send({ kind: "error", id, message: JSON.stringify({
        bytes: [...rgb], backingBytes: rgb.buffer.byteLength, offset: rgb.byteOffset
      }) });
    });
    process.send({ kind: "ready" });
  `,
  );
  const original = { ...(await import("node:child_process")) };
  await mock.module("node:child_process", () => ({
    ...original,
    fork: (...args: Parameters<typeof original.fork>) => {
      args[0] = fixture;
      return original.fork(...args);
    },
  }));
  const { createDetectionProcess } =
    await import("../../src/perception/compute/process");
  const child = createDetectionProcess();
  child.events.on("error", () => {});
  try {
    const backing = Buffer.alloc(1024 * 1024, 99);
    const rgb = backing.subarray(10, 13);
    rgb.set([11, 22, 33]);
    await expect(
      child.submit({ kind: "detect", frame: { width: 1, height: 1, rgb } }),
    ).rejects.toThrow(
      JSON.stringify({ bytes: [11, 22, 33], backingBytes: 3, offset: 0 }),
    );
    expect(backing.byteLength).toBe(1024 * 1024);
    expect([...rgb]).toEqual([11, 22, 33]);
  } finally {
    await child.destroy();
    await mock.module("node:child_process", () => original);
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

test("process entry flushes a fatal diagnostic and exits with failure", async () => {
  const { fork } = await import("node:child_process");
  const child = fork(
    new URL("../../src/perception/compute/process-entry.ts", import.meta.url),
    [],
    {
      execPath: process.execPath,
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const diagnostics: unknown[] = [];
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  child.on("message", (message: unknown) => {
    const response = responseSchema.parse(message);
    if (response.kind === "ready") child.send({ id: -1 });
    else diagnostics.push(response);
  });
  try {
    expect(await once(child, "exit")).toEqual([1, null]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      kind: "fatal",
      message: expect.stringContaining('"id"'),
    });
    expect(stderr).toContain('"id"');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
}, 10000);
