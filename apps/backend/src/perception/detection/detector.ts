import sharp from "sharp";
import { InferenceSession, Tensor } from "onnxruntime-node";
import { z } from "zod";
import type { frameSchema } from "./frame";
import { detectionComputeBudget } from "../compute/budget";
import { iou } from "../tracking/assignment";

import { detectionLabels } from "@home-agent/api/contracts";
import { detectionModelPath } from "./model";

const reviewConfidenceCeiling = 0.8;

export async function createDetector(minimumConfidence = 0.5) {
  const threshold = z.number().min(0.1).max(1).parse(minimumConfidence);
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
    const prepare = async (
      frame: z.infer<typeof frameSchema>,
      region?: Parameters<ReturnType<typeof sharp>["extract"]>[0],
    ) => {
      const started = performance.now();
      const frameWidth = region?.width ?? frame.width;
      const frameHeight = region?.height ?? frame.height;
      const scale = Math.min(width / frameWidth, height / frameHeight);
      const resizedWidth = Math.max(1, Math.trunc(frameWidth * scale));
      const resizedHeight = Math.max(1, Math.trunc(frameHeight * scale));
      const padX = Math.floor((width - resizedWidth) / 2);
      const padY = Math.floor((height - resizedHeight) / 2);
      const image = sharp(frame.rgb, {
        raw: { width: frame.width, height: frame.height, channels: 3 },
      });
      if (region) image.extract(region);
      const rgb = await image
        .resize(resizedWidth, resizedHeight, {
          fit: "fill",
          kernel: "linear",
        })
        .raw()
        .toBuffer();
      return {
        width: frameWidth,
        height: frameHeight,
        resizedWidth,
        resizedHeight,
        scale,
        padX,
        padY,
        rgb,
        preprocessMs: performance.now() - started,
      };
    };
    const infer = async (
      frame: Awaited<ReturnType<typeof prepare>>,
      mirrored = false,
      confidenceFloor = threshold,
    ) => {
      const started = performance.now();
      const { resizedWidth, resizedHeight, padX, padY } = frame;
      const pixels = width * height;
      const data = new Float32Array(3 * pixels).fill(114 / 255);
      const sourceStep = mirrored ? -3 : 3;
      for (let y = 0; y < resizedHeight; y++) {
        let source = (y * resizedWidth + (mirrored ? resizedWidth - 1 : 0)) * 3;
        let target = (y + padY) * width + padX;
        for (let x = 0; x < resizedWidth; x++) {
          data[target] = frame.rgb[source]! / 255;
          data[target + pixels] = frame.rgb[source + 1]! / 255;
          data[target + 2 * pixels] = frame.rgb[source + 2]! / 255;
          source += sourceStep;
          target++;
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
          frame.scale,
          padX,
          padY,
          confidenceFloor,
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
    const detect = async (frame: z.infer<typeof frameSchema>) => {
      const started = performance.now();
      const prepared = await prepare(frame);
      const result = await infer(prepared);
      let preprocessMs = prepared.preprocessMs + result.timing.preprocessMs;
      let inferenceMs = result.timing.inferenceMs;
      let reviewed = 0;
      const recheck = async (
        reviewFrame: typeof prepared,
        mirrored = false,
        confidenceFloor = threshold,
      ) => {
        reviewed++;
        const review = await infer(reviewFrame, mirrored, confidenceFloor);
        preprocessMs += review.timing.preprocessMs;
        inferenceMs += review.timing.inferenceMs;
        return review.detections;
      };
      const cropForReview = async (
        box: (typeof result.detections)[number],
        requireContext = false,
        contextScale = 2,
      ) => {
        const side = Math.min(
          frame.width,
          frame.height,
          Math.ceil(Math.max(box.w, box.h) * contextScale),
        );
        if (
          side < Math.max(box.w, box.h) ||
          (side === frame.width && side === frame.height)
        )
          return null;
        const left = Math.min(
          frame.width - side,
          Math.max(0, Math.floor(box.x + box.w / 2 - side / 2)),
        );
        const top = Math.min(
          frame.height - side,
          Math.max(0, Math.floor(box.y + box.h / 2 - side / 2)),
        );
        const hasContext =
          left < box.x &&
          top < box.y &&
          left + side > box.x + box.w &&
          top + side > box.y + box.h;
        if (requireContext && !hasContext) return null;

        const crop = await prepare(frame, {
          left,
          top,
          width: side,
          height: side,
        });
        preprocessMs += crop.preprocessMs;
        return {
          left,
          top,
          hasContext,
          frame: crop,
        };
      };

      const humans = result.detections.filter(
        (box) => box.className === "human",
      );
      const corrections = new Map<
        (typeof humans)[number],
        (typeof humans)[number] | null
      >();
      const reviews = humans
        .filter((box) => box.confidence < reviewConfidenceCeiling)
        .toSorted((a, b) => a.confidence - b.confidence);
      const emptyReviews: typeof humans = [];

      for (const box of reviews) {
        if (reviewed >= detectionComputeBudget.humanReviewsPerTask) break;
        const crop = await cropForReview(box);
        if (!crop) continue;
        const review = await recheck(crop.frame);

        if (!review.length && crop.hasContext) {
          emptyReviews.push(box);
          continue;
        }

        const corresponding = review
          .filter((candidate) =>
            ["human", "cat", "dog"].includes(candidate.className),
          )
          .map((candidate) => ({
            ...candidate,
            x: candidate.x + crop.left,
            y: candidate.y + crop.top,
          }))
          .map((candidate) => ({ candidate, overlap: iou(box, candidate) }))
          .filter(
            ({ candidate, overlap }) =>
              overlap >= 0.5 &&
              !humans.some(
                (other) => other !== box && iou(other, candidate) >= overlap,
              ),
          )
          .toSorted(
            (a, b) =>
              b.candidate.confidence - a.candidate.confidence ||
              b.overlap - a.overlap,
          )[0]?.candidate;
        if (
          corresponding &&
          corresponding.className !== "human" &&
          corresponding.confidence > box.confidence
        )
          corrections.set(box, corresponding);
      }

      if (
        emptyReviews.length &&
        reviewed < detectionComputeBudget.humanReviewsPerTask
      ) {
        const mirrored = await recheck(prepared, true, 0.1);
        for (const box of emptyReviews) {
          if (
            !mirrored.some(
              (candidate) =>
                iou(box, {
                  ...candidate,
                  x: frame.width - candidate.x - candidate.w,
                }) >= 0.5,
            )
          )
            corrections.set(box, null);
        }
      }

      const pets = result.detections
        .filter(
          (box) =>
            (box.className === "cat" || box.className === "dog") &&
            box.confidence < reviewConfidenceCeiling,
        )
        .toSorted((a, b) => a.confidence - b.confidence);
      for (const box of pets) {
        if (reviewed + 2 > detectionComputeBudget.reviewsPerTask) break;
        const crop = await cropForReview(box, true, 3);
        if (!crop) continue;
        const mirroredLocal = await recheck(crop.frame, true, 0.1);
        const correspondingPet = (
          detections: typeof mirroredLocal,
          mirrored: boolean,
        ) =>
          detections
            .filter(
              (candidate) =>
                candidate.className === "cat" || candidate.className === "dog",
            )
            .map((candidate) => ({
              ...candidate,
              x:
                crop.left +
                (mirrored
                  ? crop.frame.width - candidate.x - candidate.w
                  : candidate.x),
              y: candidate.y + crop.top,
            }))
            .map((candidate) => ({ candidate, overlap: iou(box, candidate) }))
            .filter(
              ({ candidate, overlap }) =>
                overlap >= 0.5 &&
                !result.detections.some(
                  (other) =>
                    other !== box &&
                    (other.className === "cat" || other.className === "dog") &&
                    iou(other, candidate) >= overlap,
                ),
            )
            .toSorted(
              (a, b) =>
                b.candidate.confidence - a.candidate.confidence ||
                b.overlap - a.overlap,
            )[0]?.candidate;
        const mirroredPet = correspondingPet(mirroredLocal, true);
        if (
          mirroredPet &&
          mirroredPet.className !== box.className &&
          mirroredPet.confidence > box.confidence
        ) {
          const localPet = correspondingPet(await recheck(crop.frame), false);
          if (
            localPet?.className === mirroredPet.className &&
            localPet.confidence > box.confidence
          )
            corrections.set(box, {
              ...box,
              classId: mirroredPet.classId,
              className: mirroredPet.className,
              confidence: Math.min(mirroredPet.confidence, localPet.confidence),
            });
        }

        if (
          mirroredLocal.some(
            (candidate) =>
              candidate.className === "cat" || candidate.className === "dog",
          )
        )
          continue;

        const mirrored = await recheck(prepared, true);
        if (
          !mirrored.some(
            (candidate) =>
              iou(box, {
                ...candidate,
                x: frame.width - candidate.x - candidate.w,
              }) >= 0.5,
          )
        )
          corrections.set(box, null);
      }

      let detections = result.detections;
      if (corrections.size) {
        const corrected = new Set(corrections.values());
        const candidates = detections
          .flatMap((box) => {
            const correction = corrections.get(box);
            return correction === null ? [] : [correction ?? box];
          })
          .toSorted((a, b) => b.confidence - a.confidence);
        detections = [];
        for (const candidate of candidates) {
          if (
            detections.some(
              (previous) =>
                (corrected.has(candidate) || corrected.has(previous)) &&
                previous.classId === candidate.classId &&
                iou(previous, candidate) >= 0.7,
            )
          )
            continue;
          detections.push(candidate);
        }
      }

      return {
        detections,
        timing: {
          preprocessMs,
          inferenceMs,
          postprocessMs: Math.max(
            0,
            performance.now() - started - preprocessMs - inferenceMs,
          ),
        },
      };
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
