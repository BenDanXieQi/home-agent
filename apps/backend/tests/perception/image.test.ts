import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as files from "node:fs/promises";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { detectImage } from "../../src/perception/detection/image";
import {
  ImageProcessingError,
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

function rejectStagingClose(stagingPath: string) {
  const nativeOpen = files.open;
  return spyOn(files, "open").mockImplementation(
    async (...args: Parameters<typeof open>) => {
      const file = await nativeOpen(...args);
      if (args[0] === stagingPath) {
        const close = file.close.bind(file);
        file.close = async () => {
          await close();
          throw new Error("Staged file close failed");
        };
      }
      return file;
    },
  );
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
    stagedImage: undefined,
    timing: {
      preprocessMs: 2,
      inferenceMs: 3,
      postprocessMs: 4,
      annotationMs: 0,
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

test("resizes in the worker and prepares a PNG without replacing the destination", async () => {
  const { path, bytes } = await imageFile();
  const outputPath = join(directory, "output", "annotated.png");
  const stagingPath = join(directory, "output", ".annotated.stage.png");
  await mkdir(dirname(outputPath));
  await writeFile(outputPath, "previous output");
  detect.mockImplementationOnce(async () => {
    await writeFile(path, "source changed after decoding");
    return {
      detections: [],
      timing: {
        preprocessMs: 2,
        inferenceMs: 3,
        postprocessMs: 4,
      },
    };
  });
  const result = await detectImage(
    detector,
    { path, resize: { width: 4, height: 3 }, outputPath },
    stagingPath,
  );
  expect(result.inputSha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(result.stagedImage).toBe(stagingPath);
  expect(await readFile(outputPath, "utf8")).toBe("previous output");
  expect(result.width).toBe(4);
  expect(result.height).toBe(3);
  expect(detect.mock.calls[0]?.[0].rgb.length).toBe(4 * 3 * 3);
  expect(await sharp(stagingPath).metadata()).toMatchObject({
    format: "png",
    width: 4,
    height: 3,
  });
  const output = await sharp(stagingPath).removeAlpha().raw().toBuffer();
  expect(output).toEqual(Buffer.from(detect.mock.calls[0]![0].rgb));
  expect((await readdir(join(directory, "output"))).toSorted()).toEqual([
    ".annotated.stage.png",
    "annotated.png",
  ]);
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

test("cleans staging after output failure without replacing the destination", async () => {
  const { path } = await imageFile();
  const outputPath = join(directory, "existing-directory");
  const stagingPath = join(directory, ".output.stage.png");
  await mkdir(outputPath);
  await writeFile(join(outputPath, "preserved.txt"), "preserve me");
  const opening = rejectStagingClose(stagingPath);
  try {
    await expect(
      detectImage(detector, { path, outputPath }, stagingPath),
    ).rejects.toMatchObject({ code: "output_failed" });
  } finally {
    opening.mockRestore();
  }
  expect(await readFile(join(outputPath, "preserved.txt"), "utf8")).toBe(
    "preserve me",
  );
  expect(await readdir(directory)).not.toContain(".output.stage.png");
});

test("requires a separate tracked staging path before writing output", async () => {
  const { path } = await imageFile();
  const outputPath = join(directory, "previous.png");
  await writeFile(outputPath, "preserve previous output");
  await expect(
    detectImage(detector, { path, outputPath }),
  ).rejects.toBeInstanceOf(ImageProcessingError);
  await expect(
    detectImage(detector, { path, outputPath }, outputPath),
  ).rejects.toMatchObject({ code: "output_failed" });
  expect(await readFile(outputPath, "utf8")).toBe("preserve previous output");
});

test("retains the output directory failure when its parent is a regular file", async () => {
  const { path } = await imageFile();
  const parent = join(directory, "regular-file");
  await writeFile(parent, "preserve me");
  const unlink = spyOn(files, "unlink").mockRejectedValue(
    new Error("unlink must not run"),
  );
  try {
    await expect(
      detectImage(
        detector,
        { path, outputPath: join(parent, "output.png") },
        join(parent, ".output.stage.png"),
      ),
    ).rejects.toMatchObject({
      code: "output_failed",
      cause: expect.objectContaining({ syscall: "mkdir" }),
    });
    expect(unlink).not.toHaveBeenCalled();
  } finally {
    unlink.mockRestore();
  }
  expect(await readFile(parent, "utf8")).toBe("preserve me");
});

test("does not overwrite or unlink an existing staging file when exclusive creation fails", async () => {
  const { path } = await imageFile();
  const outputPath = join(directory, "output.png");
  const stagingPath = join(directory, ".output.stage.png");
  await writeFile(stagingPath, "not owned by this request");
  const unlink = spyOn(files, "unlink").mockRejectedValue(
    new Error("unlink must not run"),
  );
  try {
    await expect(
      detectImage(detector, { path, outputPath }, stagingPath),
    ).rejects.toMatchObject({
      code: "output_failed",
      cause: expect.objectContaining({ code: "EEXIST" }),
    });
    expect(unlink).not.toHaveBeenCalled();
  } finally {
    unlink.mockRestore();
  }
  expect(await readFile(stagingPath, "utf8")).toBe("not owned by this request");
});

test("hands completed staging to the parent without unlinking it", async () => {
  const { path } = await imageFile();
  const outputPath = join(directory, "output.png");
  const stagingPath = join(directory, ".output.stage.png");
  const unlink = spyOn(files, "unlink").mockRejectedValue(
    new Error("unlink must not run"),
  );
  try {
    const result = await detectImage(
      detector,
      { path, outputPath },
      stagingPath,
    );
    expect(result.stagedImage).toBe(stagingPath);
    expect(unlink).not.toHaveBeenCalled();
  } finally {
    unlink.mockRestore();
  }
  expect(await readdir(directory)).toContain(".output.stage.png");
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("reports failed staging cleanup as a resource failure instead of an image error", async () => {
  const { path } = await imageFile();
  const outputPath = join(directory, "existing-directory");
  const stagingPath = join(directory, ".output.stage.png");
  await mkdir(outputPath);
  const failure = Object.assign(new Error("staging cleanup denied"), {
    code: "EACCES",
  });
  const unlink = spyOn(files, "unlink").mockRejectedValue(failure);
  const opening = rejectStagingClose(stagingPath);
  try {
    const result = detectImage(detector, { path, outputPath }, stagingPath);
    await expect(result).rejects.toMatchObject({
      name: "Error",
      message: `Cannot remove image staging file: ${stagingPath}`,
      cause: failure,
    });
    await expect(result).rejects.not.toBeInstanceOf(ImageProcessingError);
    expect(unlink).toHaveBeenCalledWith(stagingPath);
  } finally {
    unlink.mockRestore();
    opening.mockRestore();
  }
  expect(await readdir(directory)).toContain(".output.stage.png");
});
