import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { InferenceSession, Tensor } from "onnxruntime-node";
import type { createDetector } from "../../src/perception/detection/detector";
import { iou } from "../../src/perception/tracking/assignment";

// These adapters are offline evaluation boundaries, not runtime model selection.
export async function prepareCocoInput(
  frame: Parameters<Awaited<ReturnType<typeof createDetector>>["detect"]>[0],
  side: number,
  kind: "yolo11" | "yolox",
) {
  const scale = Math.min(side / frame.width, side / frame.height);
  const round =
    kind === "yolox"
      ? Math.floor
      : (value: number) => {
          const lower = Math.floor(value);
          return value - lower === 0.5
            ? lower + (lower % 2)
            : Math.round(value);
        };
  const width = Math.max(1, round(frame.width * scale));
  const height = Math.max(1, round(frame.height * scale));
  const padX =
    kind === "yolox" ? 0 : Math.max(0, Math.round((side - width) / 2 - 0.1));
  const padY =
    kind === "yolox" ? 0 : Math.max(0, Math.round((side - height) / 2 - 0.1));
  const resized = await sharp(frame.rgb, {
    raw: { width: frame.width, height: frame.height, channels: 3 },
  })
    .resize(width, height, { fit: "fill", kernel: "linear" })
    .raw()
    .toBuffer();
  const divisor = kind === "yolox" ? 1 : 255;
  const data = new Float32Array(3 * side * side).fill(114 / divisor);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) {
        data[c * side * side + (y + padY) * side + x + padX] =
          resized[(y * width + x) * 3 + (kind === "yolox" ? 2 - c : c)]! /
          divisor;
      }
  return {
    data,
    mapping: {
      width: frame.width,
      height: frame.height,
      scale,
      padX,
      padY,
      side,
    },
  };
}

function category(index: number) {
  if (index === 0) return { classId: 0, className: "human" as const };
  if (index === 15) return { classId: 1, className: "cat" as const };
  if (index === 16) return { classId: 2, className: "dog" as const };
  return undefined;
}

export function decodeCocoOutput(
  data: Float32Array,
  count: number,
  kind: Parameters<typeof prepareCocoInput>[2],
  mapping: Awaited<ReturnType<typeof prepareCocoInput>>["mapping"],
) {
  const grids = (kind === "yolox" ? [8, 16, 32] : []).flatMap((stride) => {
    const n = mapping.side / stride;
    return Array.from({ length: n * n }, (_, i) => ({
      x: i % n,
      y: Math.floor(i / n),
      stride,
    }));
  });
  if (
    data.length !== count * (kind === "yolox" ? 85 : 84) ||
    (kind === "yolox" && count !== grids.length)
  )
    throw new Error("Candidate detector output shape mismatch");
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const value = (attribute: number) =>
      kind === "yolox"
        ? data[i * 85 + attribute]!
        : data[attribute * count + i]!;
    let classIndex = 0,
      classScore = -Infinity;
    for (let c = 0; c < 80; c++) {
      const score = value(c + (kind === "yolox" ? 5 : 4));
      if (!Number.isFinite(score) || score < 0 || score > 1)
        throw new Error("Invalid candidate confidence");
      if (score > classScore) {
        classIndex = c;
        classScore = score;
      }
    }
    const label = category(classIndex);
    const confidence = classScore * (kind === "yolox" ? value(4) : 1);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
      throw new Error("Invalid candidate objectness");
    if (!label || confidence < 0.1) continue;
    const grid = grids[i];
    const cx =
      kind === "yolox" ? (value(0) + grid!.x) * grid!.stride : value(0);
    const cy =
      kind === "yolox" ? (value(1) + grid!.y) * grid!.stride : value(1);
    const w = kind === "yolox" ? Math.exp(value(2)) * grid!.stride : value(2);
    const h = kind === "yolox" ? Math.exp(value(3)) * grid!.stride : value(3);
    if (![cx, cy, w, h].every(Number.isFinite))
      throw new Error("Invalid candidate box");
    const x = Math.max(
      0,
      Math.min(mapping.width, (cx - w / 2 - mapping.padX) / mapping.scale),
    );
    const y = Math.max(
      0,
      Math.min(mapping.height, (cy - h / 2 - mapping.padY) / mapping.scale),
    );
    const right = Math.max(
      0,
      Math.min(mapping.width, (cx + w / 2 - mapping.padX) / mapping.scale),
    );
    const bottom = Math.max(
      0,
      Math.min(mapping.height, (cy + h / 2 - mapping.padY) / mapping.scale),
    );
    if (right > x && bottom > y)
      candidates.push({
        x,
        y,
        w: right - x,
        h: bottom - y,
        confidence,
        ...label,
      });
  }
  const kept: typeof candidates = [];
  for (const box of candidates.toSorted(
    (a, b) => b.confidence - a.confidence,
  )) {
    if (
      !kept.some(
        (previous) =>
          previous.classId === box.classId && iou(previous, box) >= 0.7,
      )
    )
      kept.push(box);
  }
  return kept.map((box) => ({
    ...box,
    x: Math.floor(box.x),
    y: Math.floor(box.y),
    w: Math.ceil(box.x + box.w) - Math.floor(box.x),
    h: Math.ceil(box.y + box.h) - Math.floor(box.y),
  }));
}

export async function createCocoDetector(
  path: string,
  kind: Parameters<typeof prepareCocoInput>[2],
) {
  const bytes = await readFile(path);
  sharp.concurrency(1);
  const session = await InferenceSession.create(bytes, {
    executionProviders: ["cpu"],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: "sequential",
  });
  try {
    const input = session.inputMetadata[0],
      output = session.outputMetadata[0];
    if (
      session.inputNames.length !== 1 ||
      session.outputNames.length !== 1 ||
      !input?.isTensor ||
      !output?.isTensor ||
      input.type !== "float32" ||
      output.type !== "float32"
    )
      throw new Error("Expected one float32 input and output");
    const side = input.shape[2];
    if (
      input.shape.length !== 4 ||
      input.shape[0] !== 1 ||
      input.shape[1] !== 3 ||
      typeof side !== "number" ||
      input.shape[3] !== side ||
      side > 1280 ||
      side < 32 ||
      side % 32 !== 0
    )
      throw new Error("Expected static square NCHW model input");
    return {
      metadata: {
        kind,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        input,
        output,
      },
      async detect(frame: Parameters<typeof prepareCocoInput>[0]) {
        const started = performance.now();
        const prepared = await prepareCocoInput(frame, side, kind);
        const tensor = new Tensor("float32", prepared.data, [1, 3, side, side]);
        const ready = performance.now();
        const outputs = await session
          .run({ [input.name]: tensor })
          .finally(() => tensor.dispose());
        const inferred = performance.now();
        try {
          const result = outputs[output.name];
          if (
            !result ||
            result.type !== "float32" ||
            !(result.data instanceof Float32Array) ||
            result.dims.length !== 3 ||
            result.dims[0] !== 1 ||
            result.dims[kind === "yolox" ? 2 : 1] !==
              (kind === "yolox" ? 85 : 84)
          )
            throw new Error("Unexpected candidate output tensor");
          const detections = decodeCocoOutput(
            result.data,
            result.dims[kind === "yolox" ? 1 : 2]!,
            kind,
            prepared.mapping,
          );
          return {
            detections,
            timing: {
              preprocessMs: ready - started,
              inferenceMs: inferred - ready,
              postprocessMs: performance.now() - inferred,
            },
          };
        } finally {
          for (const value of Object.values(outputs)) value.dispose();
        }
      },
      close: () => session.release(),
    };
  } catch (error) {
    await session.release();
    throw error;
  }
}
