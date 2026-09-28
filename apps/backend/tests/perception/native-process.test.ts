import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDetectionPool } from "../../src/perception/compute/pool";
import { errorDetails } from "../../src/perception/compute/protocol";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const modelPath = process.env.PERCEPTION_MODEL_PATH;
const frame = {
  width: 1920,
  height: 1080,
  rgb: new Uint8Array(1920 * 1080 * 3).fill(114),
};
const options = {
  initializeTimeoutMs: 3000,
  closeTimeoutMs: 1000,
  recoveryDelayMs: 10,
  maxRestarts: 1,
};
const require = createRequire(import.meta.url);
const nativeImports = () =>
  Object.keys(require.cache).filter((path) =>
    /[/\\](sharp|onnxruntime-node)[/\\]/.test(path),
  );
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test.skipIf(!modelPath)(
  "managed image tasks prepare in the child and publish after acceptance while ordinary failures keep the model ready",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "perception-native-image-"));
    const imagePath = join(directory, "input.png");
    const outputPath = join(directory, "output.png");
    await writeFile(imagePath, png);
    expect(nativeImports()).toEqual([]);
    const pool = await createDetectionPool(modelPath!, options);
    const pid = pool.getStatus().processId;
    try {
      const image = await pool.detectImage({
        path: imagePath,
        resize: { width: 64, height: 32 },
        outputPath,
      });
      expect(image).toMatchObject({
        kind: "image_detected",
        imagePath,
        inputSha256: createHash("sha256").update(png).digest("hex"),
        width: 64,
        height: 32,
        annotatedImage: outputPath,
      });
      expect(pool.metadata.modelPath).toBe(resolve(modelPath!));
      expect(pool.metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
      const output = await readFile(outputPath);
      expect(output.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(output.readUInt32BE(16)).toBe(64);
      expect(output.readUInt32BE(20)).toBe(32);
      expect((await readdir(directory)).toSorted()).toEqual([
        "input.png",
        "output.png",
      ]);
      expect(image.timing.readMs).toBeGreaterThan(0);
      expect(image.timing.decodeMs).toBeGreaterThan(0);
      expect(image.timing.annotationMs).toBeGreaterThan(0);
      const badPath = join(directory, "bad-image.txt");
      await writeFile(badPath, "not an image");
      await expect(pool.detectImage({ path: badPath })).rejects.toMatchObject({
        code: "invalid_image",
      });
      await expect(
        pool.detectImage({
          path: imagePath,
          outputPath: join(badPath, "output.png"),
        }),
      ).rejects.toMatchObject({ code: "output_failed" });
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
        annotationMs: 0,
      });
      expect(nativeImports()).toEqual([]);
    } finally {
      try {
        await pool.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  10000,
);

test.skipIf(!modelPath)(
  "managed image deadlines retire the writer process and remove staged output",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "perception-native-image-timeout-"),
    );
    const imagePath = join(directory, "input.png");
    await writeFile(imagePath, png);
    const pool = await createDetectionPool(modelPath!, {
      ...options,
      taskTimeoutMs: 1,
    });
    const oldPid = pool.getStatus().processId;
    try {
      await expect(
        pool.detectImage({
          path: imagePath,
          resize: { width: 3840, height: 2160 },
          outputPath: join(directory, "output.png"),
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
  },
  10000,
);
async function recovered(
  pool: Awaited<ReturnType<typeof createDetectionPool>>,
) {
  const end = performance.now() + 4000;
  while (pool.getStatus().status === "recovering" && performance.now() < end)
    await delay(10);
  expect(pool.getStatus().status).toBe("ready");
}

test.skipIf(!modelPath)(
  "worker bootstrap failures retain the model loading error",
  async () => {
    const missingPath = `${modelPath}.missing`;
    const error = await createDetectionPool(missingPath, options).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect(errorDetails(error).message).toContain(missingPath);
    // Failed startup must also release the process slot.
    const pool = await createDetectionPool(modelPath!, options);
    await pool.close();
  },
  10000,
);

test.skipIf(!modelPath)(
  "real model runs in a different process and shutdown confirms its exit",
  async () => {
    const pool = await createDetectionPool(modelPath!, options);
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
      expect(pool.metadata.workerThreadId).toBeGreaterThan(0);
    } finally {
      await pool.close();
    }
    expect(() => process.kill(pid, 0)).toThrow();
  },
  10000,
);

test.skipIf(!modelPath)(
  "real deadline kills only the compute process and replacement loads the model",
  async () => {
    const pool = await createDetectionPool(modelPath!, {
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
  },
  10000,
);

test.skipIf(!modelPath)(
  "native process abort does not kill the caller; replacement can detect",
  async () => {
    const pool = await createDetectionPool(modelPath!, options);
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
  },
  10000,
);

test.skipIf(!modelPath)(
  "thin valid frames preserve the process and restart budget across repeated detections",
  async () => {
    const pool = await createDetectionPool(modelPath!, options);
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
  },
  10000,
);

test.skipIf(!modelPath)(
  "shared pool rejects excess pixels and duplicate pools without losing caller buffers",
  async () => {
    const pool = await createDetectionPool(modelPath!, options);
    const pid = pool.getStatus().processId;
    try {
      await expect(createDetectionPool(modelPath!, options)).rejects.toThrow(
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
  },
  10000,
);
