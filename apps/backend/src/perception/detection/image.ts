import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import type { z } from "zod";
import type { createDetector } from "./detector";
import { frameLimits } from "./frame";
import {
  ImageProcessingError,
  imageLimits,
  imageRequestSchema,
} from "./image-request";

async function readImage(path: string) {
  // Nonblocking open also lets us reject a FIFO before waiting for a writer.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Image input must be a regular file");
    if (stat.size > imageLimits.maxFileBytes)
      throw new Error("Image file exceeds the 32 MiB limit");
    // One extra byte detects growth without allowing readFile() to allocate
    // beyond the checked size. Hashing and decoding use this same byte snapshot.
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > stat.size) throw new Error("Image file grew while being read");
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function removeStaging(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return;
    // An owned file remains: the parent must retire the process before retrying
    // cleanup. Keep this distinct from an ordinary input/output error.
    throw new Error(`Cannot remove image staging file: ${path}`, {
      cause: error,
    });
  }
}

// All file bytes, decoded pixels and native image operations stay in the worker.
export async function detectImage(
  detector: Pick<Awaited<ReturnType<typeof createDetector>>, "detect">,
  input: z.infer<typeof imageRequestSchema>,
  stagingPath?: string,
) {
  const imagePath = resolve(input.path);
  const readStarted = performance.now();
  let bytes;
  let inputSha256;
  try {
    bytes = await readImage(imagePath);
    inputSha256 = createHash("sha256").update(bytes).digest("hex");
  } catch (cause) {
    throw new ImageProcessingError(
      "invalid_image",
      `Cannot read image: ${imagePath}`,
      {
        cause,
      },
    );
  }
  const readMs = performance.now() - readStarted;

  const decodeStarted = performance.now();
  let decoded;
  try {
    const image = sharp(bytes, { limitInputPixels: frameLimits.maxPixels });
    const metadata = await image.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > frameLimits.maxDimension ||
      metadata.height > frameLimits.maxDimension ||
      metadata.width * metadata.height > frameLimits.maxPixels
    )
      throw new Error("Image dimensions exceed the frame limits");
    if (input.resize)
      image.resize(input.resize.width, input.resize.height, {
        fit: "fill",
        kernel: "lanczos3",
      });
    decoded = await image
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (cause) {
    throw new ImageProcessingError(
      "invalid_image",
      `Cannot decode image: ${imagePath}`,
      {
        cause,
      },
    );
  }
  const decodeMs = performance.now() - decodeStarted;
  const { data, info } = decoded;
  // Inference errors retain their identity so the compute pool can recover.
  const result = await detector.detect({
    width: info.width,
    height: info.height,
    rgb: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  });

  let stagedImage;
  let annotationMs = 0;
  if (input.outputPath) {
    const annotationStarted = performance.now();
    const outputPath = resolve(input.outputPath);
    const staging = stagingPath ? resolve(stagingPath) : undefined;
    if (
      !staging ||
      staging === outputPath ||
      dirname(staging) !== dirname(outputPath)
    )
      throw new ImageProcessingError(
        "output_failed",
        "Image output requires a separate staging file in the output directory",
      );
    let stageCreated = false;
    try {
      try {
        await mkdir(dirname(outputPath), { recursive: true });
        const stagedFile = await open(staging, "wx", 0o600);
        stageCreated = true;
        await stagedFile.close();
        const boxes = result.detections
          .map(
            (box) =>
              `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="none" stroke="${box.classId === 0 ? "#00ff88" : "#ffcc00"}" stroke-width="3"/><text x="${box.x}" y="${Math.max(18, box.y - 5)}" font-size="18" fill="#00ff88" stroke="#000" stroke-width="0.4">${box.className} ${box.confidence.toFixed(3)}</text>`,
          )
          .join("");
        await sharp(data, {
          raw: { width: info.width, height: info.height, channels: 3 },
        })
          .composite([
            {
              input: Buffer.from(
                `<svg width="${info.width}" height="${info.height}">${boxes}</svg>`,
              ),
            },
          ])
          .png()
          .toFile(staging);
        // The parent must accept this completed staging file before publication.
        stagedImage = staging;
        stageCreated = false;
      } catch (cause) {
        throw new ImageProcessingError(
          "output_failed",
          `Cannot prepare annotated image: ${outputPath}`,
          { cause },
        );
      }
    } finally {
      if (stageCreated) await removeStaging(staging);
    }
    annotationMs = performance.now() - annotationStarted;
  }
  return {
    imagePath,
    inputSha256,
    width: info.width,
    height: info.height,
    stagedImage,
    detections: result.detections,
    timing: { ...result.timing, readMs, decodeMs, annotationMs },
  };
}
