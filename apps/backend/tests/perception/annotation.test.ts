import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { detectImage } from "../../src/perception/detection/image";
import { createDetectionPool } from "../../src/perception/compute/pool";

const atomic = { ...(await import("write-file-atomic")) };
const writePng = (path: string, data: Buffer) =>
  atomic.default(path, data, { mode: 0o600 });
let publish = writePng;
await mock.module("write-file-atomic", () => ({
  ...atomic,
  default: (...args: Parameters<typeof writePng>) => publish(...args),
}));
const { saveAnnotatedImage } =
  await import("../../scripts/perception-annotation");
let directory: string;
let inputPath: string;
let outputPath: string;
const frame = { width: 1, height: 1, rgb: new Uint8Array(3).fill(114) };
const poolOptions = { initializeTimeoutMs: 3000, closeTimeoutMs: 1000 };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "perception-export-"));
  inputPath = join(directory, "input.png");
  outputPath = join(directory, "output.png");
  await sharp({
    create: { width: 32, height: 24, channels: 3, background: "#334455" },
  })
    .png()
    .toFile(inputPath);
  publish = writePng;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await mock.module("write-file-atomic", () => atomic);
});

async function detected() {
  return await detectImage(
    {
      detect: async () => ({
        detections: [
          {
            x: 3,
            y: 5,
            w: 12,
            h: 10,
            classId: 0,
            className: "human",
            confidence: 0.9,
          },
        ],
        timing: { preprocessMs: 0, inferenceMs: 0, postprocessMs: 0 },
      }),
    },
    { path: inputPath, resize: { width: 64, height: 48 } },
  );
}

test("exports a complete annotated PNG at the detection dimensions", async () => {
  const result = await detected();
  await writeFile(outputPath, "previous output");
  expect(await saveAnnotatedImage(result, outputPath)).toBe(outputPath);
  expect(await sharp(outputPath).metadata()).toMatchObject({
    format: "png",
    width: 64,
    height: 48,
  });
  const { data, info } = await sharp(outputPath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const border = (5 * info.width + 3) * info.channels;
  expect(data[border + 1]).toBeGreaterThan(200);
  expect((await readdir(directory)).toSorted()).toEqual([
    "input.png",
    "output.png",
  ]);
});

test("refuses to annotate changed source bytes and preserves the destination", async () => {
  const result = await detected();
  await writeFile(outputPath, "previous output");
  await sharp({
    create: { width: 32, height: 24, channels: 3, background: "red" },
  })
    .png()
    .toFile(inputPath);
  await expect(saveAnnotatedImage(result, outputPath)).rejects.toThrow(
    "Image changed after detection",
  );
  expect(await readFile(outputPath, "utf8")).toBe("previous output");
});

test("failed replacement preserves an existing directory and removes the temporary file", async () => {
  const result = await detected();
  await mkdir(outputPath);
  await writeFile(join(outputPath, "keep.txt"), "preserved");
  await expect(saveAnnotatedImage(result, outputPath)).rejects.toBeDefined();
  expect(await readFile(join(outputPath, "keep.txt"), "utf8")).toBe(
    "preserved",
  );
  expect((await readdir(directory)).toSorted()).toEqual([
    "input.png",
    "output.png",
  ]);
});

test("a stalled export cannot hold detection capacity or either pool's shutdown", async () => {
  const pool = await createDetectionPool(poolOptions);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  publish = async (...args) => {
    entered.resolve();
    await release.promise;
    await writePng(...args);
  };
  const result = await pool.detectImage({ path: inputPath });
  const saving = saveAnnotatedImage(result, outputPath);
  try {
    await entered.promise;
    expect(pool.getStatus().activeRequests).toBe(0);
    const detections = await Promise.all([
      pool.detect(frame),
      pool.detect(frame),
    ]);
    expect(detections.every((item) => item.kind === "detected")).toBe(true);
    await pool.close();
    const replacement = await createDetectionPool(poolOptions);
    try {
      expect((await replacement.detect(frame)).kind).toBe("detected");
      await replacement.close();
    } finally {
      await replacement.close();
    }
    release.resolve();
    await saving;
  } finally {
    release.resolve();
    await Promise.allSettled([saving, pool.close()]);
  }
}, 10000);

test("an export failure cannot poison a subsequent pure detection pool", async () => {
  const previous = await createDetectionPool(poolOptions);
  publish = async () => {
    throw new Error("disk unavailable");
  };
  try {
    const result = await previous.detectImage({ path: inputPath });
    await expect(saveAnnotatedImage(result, outputPath)).rejects.toThrow(
      "disk unavailable",
    );
    expect(previous.getStatus()).toMatchObject({
      status: "ready",
      restarts: 0,
    });
  } finally {
    await previous.close();
  }
  const replacement = await createDetectionPool(poolOptions);
  try {
    expect((await replacement.detect(frame)).kind).toBe("detected");
    await replacement.close();
    expect(replacement.getStatus().status).toBe("closed");
  } finally {
    await replacement.close();
  }
}, 10000);
