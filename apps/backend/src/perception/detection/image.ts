import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
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

// Shared bounded decoding for the inference worker and the standalone debug exporter.
export async function loadImage(input: z.infer<typeof imageRequestSchema>) {
  const imagePath = resolve(input.path);
  const readStarted = performance.now();
  let bytes;
  let inputSha256;
  try {
    bytes = await readImage(imagePath);
    inputSha256 = createHash("sha256").update(bytes).digest("hex");
  } catch (cause) {
    throw new ImageProcessingError(`Cannot read image: ${imagePath}`, {
      cause,
    });
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
    throw new ImageProcessingError(`Cannot decode image: ${imagePath}`, {
      cause,
    });
  }
  const decodeMs = performance.now() - decodeStarted;
  const { data, info } = decoded;
  return {
    imagePath,
    inputSha256,
    frame: {
      width: info.width,
      height: info.height,
      rgb: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    },
    timing: { readMs, decodeMs },
  };
}

export async function detectImage(
  detector: Pick<Awaited<ReturnType<typeof createDetector>>, "detect">,
  input: z.infer<typeof imageRequestSchema>,
) {
  const image = await loadImage(input);
  // Native inference failures keep their identity for process recovery.
  const result = await detector.detect(image.frame);
  return {
    imagePath: image.imagePath,
    inputSha256: image.inputSha256,
    width: image.frame.width,
    height: image.frame.height,
    detections: result.detections,
    timing: { ...image.timing, ...result.timing },
  };
}
