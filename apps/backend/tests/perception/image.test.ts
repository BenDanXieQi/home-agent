import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { detectImage } from "../../src/perception/detection/image";
import {
  imageLimits,
  imageRequestSchema,
} from "../../src/perception/detection/image-request";

let directory: string;
const detect = mock<Parameters<typeof detectImage>[0]["detect"]>(async () => ({
  detections: [],
  timing: {
    preprocessMs: 2,
    inferenceMs: 3,
    postprocessMs: 4,
  },
}));
const detector: Parameters<typeof detectImage>[0] = {
  detect,
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "perception-image-"));
  detect.mockClear();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function imageFile() {
  const path = join(directory, "input.png");
  const bytes = await sharp({
    create: {
      width: 2,
      height: 1,
      channels: 4,
      background: { r: 255, g: 64, b: 128, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  await writeFile(path, bytes);
  return { path, bytes };
}

test("checks resize dimensions and pixel count at the lightweight request boundary", () => {
  expect(imageRequestSchema.parse({ path: "image.png" })).toEqual({
    path: resolve("image.png"),
  });
  for (const input of [
    { path: "" },
    { path: "x".repeat(4097) },
    { path: "image.png", outputPath: "" },
    { path: "image.png", resize: { width: 8193, height: 1 } },
    { path: "image.png", resize: { width: 4096, height: 2161 } },
  ])
    expect(imageRequestSchema.safeParse(input).success).toBe(false);
  expect(
    imageRequestSchema.safeParse({
      path: "image.png",
      resize: { width: 3840, height: 2160 },
    }).success,
  ).toBe(true);
});

test("hashes the exact encoded bytes and decodes packed RGB without alpha", async () => {
  const { path, bytes } = await imageFile();
  const result = await detectImage(detector, { path });
  expect(result).toMatchObject({
    imagePath: path,
    inputSha256: createHash("sha256").update(bytes).digest("hex"),
    width: 2,
    height: 1,
    timing: {
      preprocessMs: 2,
      inferenceMs: 3,
      postprocessMs: 4,
    },
  });
  expect(detect.mock.calls[0]?.[0]).toEqual({
    width: 2,
    height: 1,
    rgb: new Uint8Array([255, 64, 128, 255, 64, 128]),
  });
  expect(result.timing.readMs).toBeGreaterThanOrEqual(0);
  expect(result.timing.decodeMs).toBeGreaterThanOrEqual(0);
});

test("resizes the decoded snapshot and keeps its hash if the source later changes", async () => {
  const { path, bytes } = await imageFile();
  detect.mockImplementationOnce(async () => {
    await writeFile(path, "source changed after decoding");
    return {
      detections: [],
      timing: { preprocessMs: 2, inferenceMs: 3, postprocessMs: 4 },
    };
  });
  const result = await detectImage(detector, {
    path,
    resize: { width: 4, height: 3 },
  });
  expect(result.inputSha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect([result.width, result.height]).toEqual([4, 3]);
  expect(detect.mock.calls[0]?.[0].rgb.length).toBe(4 * 3 * 3);
});

test.each(["missing", "directory", "invalid"] as const)(
  "rejects %s image input without invoking inference",
  async (kind) => {
    const path = join(directory, kind);
    if (kind === "directory") await mkdir(path);
    if (kind === "invalid") await writeFile(path, "not an image");
    await expect(detectImage(detector, { path })).rejects.toMatchObject({
      name: "ImageProcessingError",
      code: "invalid_image",
    });
    expect(detect).not.toHaveBeenCalled();
  },
);

test("rejects files over the encoded byte limit before decoding", async () => {
  const path = join(directory, "oversized.png");
  const file = await open(path, "w");
  try {
    await file.truncate(imageLimits.maxFileBytes + 1);
  } finally {
    await file.close();
  }
  await expect(detectImage(detector, { path })).rejects.toMatchObject({
    code: "invalid_image",
    cause: expect.objectContaining({
      message: "Image file exceeds the 32 MiB limit",
    }),
  });
  expect(detect).not.toHaveBeenCalled();
});

test.each([
  { width: 8193, height: 1 },
  { width: 4096, height: 2161 },
])(
  "rejects $width x $height source images even when the requested resize is small",
  async ({ width, height }) => {
    const path = join(directory, "oversized.svg");
    await writeFile(
      path,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`,
    );
    await expect(
      detectImage(detector, { path, resize: { width: 2, height: 2 } }),
    ).rejects.toMatchObject({ code: "invalid_image" });
    expect(detect).not.toHaveBeenCalled();
  },
);

test("retains inference errors so the pool can recover the native runtime", async () => {
  const { path } = await imageFile();
  const failure = new Error("native inference failed");
  detect.mockRejectedValueOnce(failure);
  await expect(detectImage(detector, { path })).rejects.toBe(failure);
});
