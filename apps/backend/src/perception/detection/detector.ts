import sharp from "sharp";
import { InferenceSession, Tensor } from "onnxruntime-node";
import { z } from "zod";
import type { frameSchema } from "./frame";
import { detectionComputeBudget } from "../compute/budget";

import { detectionLabels } from "@home-agent/api/contracts";
import { detectionModelPath } from "./model";

export async function createDetector(minimumConfidence = 0.5) {
  const threshold = z.number().min(0.1).max(1).parse(minimumConfidence);
  // libvips has process-wide configuration; every detector uses the same budget.
  sharp.concurrency(detectionComputeBudget.sharpThreads);
  const session = await InferenceSession.create(detectionModelPath, {
    executionProviders: ["cpu"],
    intraOpNumThreads: detectionComputeBudget.ortIntraOpThreads,
    executionMode: "sequential",
  });
  try {
    const input = session.inputMetadata[0];
    const output = session.outputMetadata[0];
    if (
      !input?.isTensor ||
      !output?.isTensor ||
      session.inputNames.length !== 1 ||
      session.outputNames.length !== 1
    ) {
      throw new Error(
        "Detection requires one tensor input and one tensor output",
      );
    }
    const [batch, channels, height, width] = input.shape;
    if (
      input.type !== "float32" ||
      input.shape.length !== 4 ||
      batch !== 1 ||
      channels !== 3 ||
      typeof height !== "number" ||
      typeof width !== "number" ||
      height <= 0 ||
      width <= 0 ||
      height > 4096 ||
      width > 4096
    ) {
      throw new Error(
        "Detection requires static float32 [1,3,height,width] input",
      );
    }
    if (
      output.type !== "float32" ||
      output.shape.length !== 3 ||
      output.shape[0] !== 1 ||
      output.shape[1] !== 9
    ) {
      throw new Error(
        "det_4C requires float32 [1,9,boxes] output (five classes)",
      );
    }
    const metadata = {
      input: { ...input, type: "float32" as const, shape: [...input.shape] },
      output: { ...output, type: "float32" as const, shape: [...output.shape] },
      provider: "cpu" as const,
      sharpConcurrency: sharp.concurrency(),
      intraOpNumThreads: detectionComputeBudget.ortIntraOpThreads,
    };
    // Internal frames come from the validated IPC request or bounded image decoder.
    const detect = async (frame: z.infer<typeof frameSchema>) => {
      const started = performance.now();
      const scale = Math.min(width / frame.width, height / frame.height);
      // A valid thin image still occupies one raster pixel after downscaling.
      const resizedWidth = Math.max(1, Math.trunc(frame.width * scale));
      const resizedHeight = Math.max(1, Math.trunc(frame.height * scale));
      const padX = Math.floor((width - resizedWidth) / 2);
      const padY = Math.floor((height - resizedHeight) / 2);
      const resized = await sharp(frame.rgb, {
        raw: { width: frame.width, height: frame.height, channels: 3 },
      })
        .resize(resizedWidth, resizedHeight, {
          fit: "fill",
          kernel: "linear",
        })
        .raw()
        .toBuffer();
      const pixels = width * height;
      const data = new Float32Array(3 * pixels).fill(114 / 255);
      for (let y = 0; y < resizedHeight; y++) {
        for (let x = 0; x < resizedWidth; x++) {
          for (let channel = 0; channel < 3; channel++) {
            data[channel * pixels + (y + padY) * width + x + padX] =
              resized[(y * resizedWidth + x) * 3 + channel]! / 255;
          }
        }
      }
      const prepared = performance.now();
      const tensor = new Tensor("float32", data, [1, 3, height, width]);
      let outputs;
      try {
        outputs = await session.run({ [input.name]: tensor });
      } catch (error) {
        tensor.dispose();
        throw error;
      }
      const inferred = performance.now();
      try {
        const result = outputs[output.name];
        if (
          !result ||
          result.type !== "float32" ||
          result.dims.length !== 3 ||
          result.dims[0] !== 1 ||
          result.dims[1] !== 9 ||
          !(result.data instanceof Float32Array)
        ) {
          throw new Error("Unexpected detection output tensor");
        }
        const detections = decodeDetections(
          result.data,
          result.dims[2]!,
          frame.width,
          frame.height,
          scale,
          padX,
          padY,
          threshold,
        );
        return {
          detections,
          timing: {
            preprocessMs: prepared - started,
            inferenceMs: inferred - prepared,
            postprocessMs: performance.now() - inferred,
          },
        };
      } finally {
        tensor.dispose();
        for (const value of Object.values(outputs)) value.dispose();
      }
    };
    return { metadata, detect, close: () => session.release() };
  } catch (error) {
    await session.release();
    throw error;
  }
}

function decodeDetections(
  data: Float32Array,
  count: number,
  width: number,
  height: number,
  scale: number,
  padX: number,
  padY: number,
  minimumConfidence: number,
) {
  const candidates = [];
  for (let index = 0; index < count; index++) {
    let classId = 0;
    let confidence = -Infinity;
    for (let category = 0; category < detectionLabels.length; category++) {
      const score = data[(4 + category) * count + index]!;
      if (!Number.isFinite(score) || score < 0 || score > 1)
        throw new Error("Invalid detection confidence");
      if (score > confidence) {
        confidence = score;
        classId = category;
      }
    }
    const cx = data[index]!;
    const cy = data[count + index]!;
    const bw = data[2 * count + index]!;
    const bh = data[3 * count + index]!;
    if (![cx, cy, bw, bh].every(Number.isFinite))
      throw new Error("Non-finite detection box");
    if (confidence < minimumConfidence) continue;
    const left = clip((cx - bw / 2 - padX) / scale, width);
    const top = clip((cy - bh / 2 - padY) / scale, height);
    const right = clip((cx + bw / 2 - padX) / scale, width);
    const bottom = clip((cy + bh / 2 - padY) / scale, height);
    if (right <= left || bottom <= top) continue;
    candidates.push({
      left,
      top,
      right,
      bottom,
      confidence,
      classId,
    });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const kept: typeof candidates = [];
  for (const candidate of candidates) {
    if (
      kept.some((previous) => {
        if (candidate.classId !== previous.classId) return false;
        const intersection =
          Math.max(
            0,
            Math.min(candidate.right, previous.right) -
              Math.max(candidate.left, previous.left),
          ) *
          Math.max(
            0,
            Math.min(candidate.bottom, previous.bottom) -
              Math.max(candidate.top, previous.top),
          );
        const union =
          (candidate.right - candidate.left) *
            (candidate.bottom - candidate.top) +
          (previous.right - previous.left) * (previous.bottom - previous.top) -
          intersection;
        return union > 0 && intersection / union >= 0.7;
      })
    )
      continue;
    kept.push(candidate);
  }
  // NMS uses continuous edges; outward rounding is only the output pixel
  // representation, so it cannot turn distinct small boxes into duplicates.
  return kept.map((box) => {
    const x = Math.floor(box.left);
    const y = Math.floor(box.top);
    return {
      x,
      y,
      w: Math.ceil(box.right) - x,
      h: Math.ceil(box.bottom) - y,
      confidence: box.confidence,
      classId: box.classId,
      className: detectionLabels[box.classId]!,
    };
  });
}

function clip(value: number, limit: number) {
  return Math.min(Math.max(value, 0), limit);
}
