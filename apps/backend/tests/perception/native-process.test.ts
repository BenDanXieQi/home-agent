import { availableParallelism } from "node:os";
import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDetectionPool } from "../../src/perception/compute/pool";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { detectionModelPath } from "../../src/perception/detection/model";
const frame = {
  width: 1920,
  height: 1080,
  rgb: new Uint8Array(1920 * 1080 * 3).fill(114),
};
const options = {
  cpuRatio: 1 / availableParallelism(),
  initializeTimeoutMs: 3000,
  closeTimeoutMs: 1000,
  recoveryDelayMs: 10,
  maxRestarts: 1,
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("pool imports and detection leave native dependencies in the compute process", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "perception-native-isolation-"),
  );
  try {
    const imagePath = join(directory, "input.png");
    await writeFile(imagePath, png);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL("./fixtures/native-isolation.ts", import.meta.url),
        ),
        imagePath,
      ],
      { timeout: 10000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      beforeImport: [],
      afterImport: [],
      afterInitialization: [],
      afterDetection: [],
      afterClose: [],
      detected: "image_detected",
      separateProcess: true,
      positiveControl: { sharp: true, onnx: true },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test("file detection stays in the child and ordinary input errors keep the model ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "perception-native-image-"));
  const imagePath = join(directory, "input.png");
  await writeFile(imagePath, png);
  const pool = await createDetectionPool(options);
  const pid = pool.getStatus().processId;
  try {
    const image = await pool.detectImage({
      path: imagePath,
      resize: { width: 64, height: 32 },
    });
    expect(image).toMatchObject({
      kind: "image_detected",
      imagePath,
      inputSha256: createHash("sha256").update(png).digest("hex"),
      width: 64,
      height: 32,
    });
    expect(pool.metadata.modelPath).toBe(detectionModelPath);
    expect(pool.metadata.sha256).toBe(
      "eb55fff61225c1e4d90312a0f70f675ce19632bae1b51b948a3c8dc96765bf2f",
    );
    expect(await readdir(directory)).toEqual(["input.png"]);
    expect(image.timing.readMs).toBeGreaterThan(0);
    expect(image.timing.decodeMs).toBeGreaterThan(0);
    const badPath = join(directory, "bad-image.txt");
    await writeFile(badPath, "not an image");
    await expect(pool.detectImage({ path: badPath })).rejects.toMatchObject({
      code: "invalid_image",
    });
    expect(pool.getStatus()).toMatchObject({
      status: "ready",
      restarts: 0,
      processId: pid,
      activeImageRequests: 0,
      activeRgbBytes: 0,
    });
    const raw = await pool.detect(frame);
    expect(raw.timing).toMatchObject({
      readMs: 0,
      decodeMs: 0,
    });
  } finally {
    try {
      await pool.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 10000);

test("file detection deadlines retire the compute process without creating output files", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "perception-native-image-timeout-"),
  );
  const imagePath = join(directory, "input.png");
  await writeFile(imagePath, png);
  const pool = await createDetectionPool({
    ...options,
    taskTimeoutMs: 1,
  });
  const oldPid = pool.getStatus().processId;
  try {
    await expect(
      pool.detectImage({
        path: imagePath,
        resize: { width: 3840, height: 2160 },
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    await recovered(pool);
    expect(pool.getStatus().processId).not.toBe(oldPid);
    expect(() => process.kill(oldPid!, 0)).toThrow();
    expect(await readdir(directory)).toEqual(["input.png"]);
  } finally {
    try {
      await pool.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 10000);
async function recovered(
  pool: Awaited<ReturnType<typeof createDetectionPool>>,
) {
  const end = performance.now() + 4000;
  while (pool.getStatus().status === "recovering" && performance.now() < end)
    await delay(10);
  expect(pool.getStatus()).toMatchObject({ status: "ready" });
}

test("real model runs in a different process and shutdown confirms its exit", async () => {
  const pool = await createDetectionPool(options);
  const pid = pool.getStatus().processId!;
  try {
    expect(pid).not.toBe(process.pid);
    const result = await pool.detect(frame);
    expect(result.kind).toBe("detected");
    expect(result.detections).toEqual([]);
    const { timing } = result;
    expect(timing.queueMs).toBeGreaterThanOrEqual(0);
    expect(timing.workerDispatchMs).toBeGreaterThanOrEqual(0);
    expect(timing.ipcRoundTripMs).toBeGreaterThanOrEqual(0);
    expect(
      timing.preprocessMs + timing.inferenceMs + timing.postprocessMs,
    ).toBeLessThanOrEqual(timing.totalMs);
    expect(pool.metadata.sharpConcurrency).toBe(1);
    expect(pool.metadata.workerThreadIds[0]).toBeGreaterThan(0);
  } finally {
    await pool.close();
  }
  expect(() => process.kill(pid, 0)).toThrow();
}, 10000);

test("real deadline kills only the compute process and replacement loads the model", async () => {
  const pool = await createDetectionPool({
    ...options,
    taskTimeoutMs: 1,
  });
  const oldPid = pool.getStatus().processId;
  try {
    await expect(pool.detect(frame)).rejects.toMatchObject({
      code: "timeout",
    });
    await recovered(pool);
    expect(pool.getStatus().processId).not.toBe(oldPid);
    expect(() => process.kill(oldPid!, 0)).toThrow();
  } finally {
    await pool.close();
  }
}, 10000);

test("native process abort does not kill the caller; replacement can detect", async () => {
  const pool = await createDetectionPool(options);
  const oldPid = pool.getStatus().processId!;
  try {
    const task = pool.detect(frame).catch((error: unknown) => error);
    process.kill(oldPid, "SIGABRT");
    expect(await task).toBeInstanceOf(Error);
    await recovered(pool);
    expect(pool.getStatus().processId).not.toBe(oldPid);
    expect((await pool.detect(frame)).kind).toBe("detected");
  } finally {
    await pool.close();
  }
}, 10000);

test("thin valid frames preserve the process and restart budget across repeated detections", async () => {
  const pool = await createDetectionPool(options);
  const pid = pool.getStatus().processId;
  try {
    for (const [width, height] of [
      [8192, 1],
      [1, 8192],
      [8192, 1],
      [1, 8192],
    ] as const) {
      const result = await pool.detect({
        width,
        height,
        rgb: new Uint8Array(width * height * 3).fill(114),
      });
      expect(result.kind).toBe("detected");
      expect(pool.getStatus()).toMatchObject({
        status: "ready",
        restarts: 0,
        processId: pid,
      });
    }
    expect((await pool.detect(frame)).kind).toBe("detected");
  } finally {
    await pool.close();
  }
}, 10000);

test("shared pool rejects excess pixels and duplicate pools without losing caller buffers", async () => {
  const pool = await createDetectionPool(options);
  const pid = pool.getStatus().processId;
  try {
    await expect(createDetectionPool(options)).rejects.toThrow(
      "share the existing pool",
    );
    await expect(
      pool.detect({
        width: 4096,
        height: 2160,
        rgb: new Uint8Array(4096 * 2160 * 3),
      }),
    ).rejects.toThrow("pixel budget");
    const pixels = new Uint8Array(3840 * 2160 * 3).fill(114);
    const accepted = { width: 3840, height: 2160, rgb: pixels };
    const results = await Promise.all([
      pool.detect(accepted),
      pool.detect(accepted),
    ]);
    expect(results.every((result) => result.kind === "detected")).toBe(true);
    expect(pixels.byteLength).toBe(3840 * 2160 * 3);
    expect(pixels[0]).toBe(114);
    expect(pixels.at(-1)).toBe(114);
    expect(pool.getStatus()).toMatchObject({
      status: "ready",
      restarts: 0,
      processId: pid,
    });
  } finally {
    await pool.close();
  }
}, 10000);

test("a deployment missing its fixed model fails with the asset path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "perception-missing-asset-"));
  try {
    await cp(
      new URL("../../src/perception/", import.meta.url),
      join(directory, "src/perception"),
      { recursive: true },
    );
    await mkdir(join(directory, "src/household/identity"), { recursive: true });
    await cp(
      new URL(
        "../../src/household/identity/appearance-evidence.ts",
        import.meta.url,
      ),
      join(directory, "src/household/identity/appearance-evidence.ts"),
    );
    await mkdir(join(directory, "src/mijia/media"), { recursive: true });
    await cp(
      new URL("../../src/mijia/media/analysis-stream.ts", import.meta.url),
      join(directory, "src/mijia/media/analysis-stream.ts"),
    );
    await symlink(
      fileURLToPath(new URL("../../node_modules", import.meta.url)),
      join(directory, "node_modules"),
      "dir",
    );
    const entry = join(directory, "src/perception/compute/pool.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import { createDetectionPool } from ${JSON.stringify(entry)};
      await createDetectionPool({ initializeTimeoutMs: 3000, closeTimeoutMs: 1000 });
    `,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain(join(directory, "models/det_4C.onnx"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
