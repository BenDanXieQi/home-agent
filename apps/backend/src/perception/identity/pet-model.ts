import { prepareOpenCv } from "./opencv-runtime";
import { selectPetPhotoRegions } from "./pet-regions";
import { InferenceSession, Tensor } from "onnxruntime-node";
import cv from "@techstark/opencv-js";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import {
  identityFeatureSchema,
  identityCapacity,
} from "@home-agent/api/contracts";
import type { identityRequestSchema } from "./protocol";
import models from "./models.json";
import frameProfile from "./profile.json";
import { petProfile } from "./processing-version";
import { iou } from "../tracking/assignment";

export async function createPetModel(directory: string) {
  await prepareOpenCv();
  sharp.concurrency(1);
  const spec = models.models.pet;
  for (const [file, hash] of [
    [spec.file, spec.sha256],
    [spec.licenseFile, spec.licenseSha256],
  ]) {
    if (
      createHash("sha256")
        .update(await readFile(join(directory, file!)))
        .digest("hex") !== hash
    )
      throw new Error(`Pet model fingerprint mismatch: ${file}`);
  }
  const session = await InferenceSession.create(join(directory, spec.file), {
    executionProviders: ["cpu"],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: "sequential",
  });
  if (
    session.inputNames.join() !== "input" ||
    session.outputNames.join() !== "embedding"
  ) {
    await session.release();
    throw new Error("Invalid pet recognition model contract");
  }
  async function sample(
    rgb: Uint8Array,
    track: Extract<
      z.infer<typeof identityRequestSchema>,
      { kind: "tracking" }
    >["tracks"][number],
    includeImage: boolean,
  ) {
    const box = track.measuredBox;
    const left = Math.max(0, Math.floor(box.x));
    const top = Math.max(0, Math.floor(box.y));
    const width = Math.min(
      frameProfile.width - left,
      Math.ceil(box.x + box.w) - left,
    );
    const height = Math.min(
      frameProfile.height - top,
      Math.ceil(box.y + box.h) - top,
    );
    if (Math.min(width, height) < petProfile.minimumSide) return null;
    const crop = await sharp(rgb, {
      raw: {
        width: frameProfile.width,
        height: frameProfile.height,
        channels: 3,
      },
    })
      .extract({ left, top, width, height })
      .resize(petProfile.side, petProfile.side, petProfile.resize)
      .raw()
      .toBuffer();
    const image = cv.matFromArray(
      petProfile.side,
      petProfile.side,
      cv.CV_8UC3,
      crop,
    );
    const gray = new cv.Mat();
    const laplacian = new cv.Mat();
    const mean = new cv.Mat();
    const deviation = new cv.Mat();
    let sharpness;
    try {
      cv.cvtColor(image, gray, cv.COLOR_RGB2GRAY);
      cv.Laplacian(gray, laplacian, cv.CV_64F, 1, 1, 0, cv.BORDER_DEFAULT);
      cv.meanStdDev(laplacian, mean, deviation);
      sharpness = deviation.data64F[0]! ** 2;
    } finally {
      for (const mat of [image, gray, laplacian, mean, deviation]) mat.delete();
    }
    if (!Number.isFinite(sharpness) || sharpness < petProfile.minimumSharpness)
      return null;
    const pixels = petProfile.side ** 2;
    const input = new Float32Array(3 * pixels);
    for (let channel = 0; channel < 3; channel++)
      for (let pixel = 0; pixel < pixels; pixel++)
        input[channel * pixels + pixel] =
          (crop[pixel * 3 + channel]! / 255 - petProfile.mean[channel]!) /
          petProfile.std[channel]!;
    const tensor = new Tensor("float32", input, [
      1,
      3,
      petProfile.side,
      petProfile.side,
    ]);
    const outputs = await session
      .run({ input: tensor })
      .finally(() => tensor.dispose());
    let feature;
    try {
      const output = outputs.embedding;
      if (
        !output ||
        output.type !== "float32" ||
        output.dims.length !== 2 ||
        output.dims[0] !== 1 ||
        output.dims[1] !== petProfile.featureDimensions ||
        !(output.data instanceof Float32Array)
      )
        throw new Error("Invalid pet embedding output");
      feature = identityFeatureSchema.parse(Array.from(output.data));
    } finally {
      for (const output of Object.values(outputs)) output.dispose();
    }
    const imageBytes = includeImage
      ? await sharp(crop, {
          raw: { width: petProfile.side, height: petProfile.side, channels: 3 },
        })
          .jpeg({ quality: 95 })
          .toBuffer()
      : null;
    return {
      feature,
      sharpness,
      detectionScore: null,
      cropSha256: createHash("sha256").update(crop).digest("hex"),
      ...(imageBytes ? { image: imageBytes.toString("base64") } : {}),
    };
  }
  return {
    async extract(request: z.infer<typeof identityRequestSchema>) {
      const tracks = request.tracks.filter(
        (track) =>
          track.className !== "human" &&
          (request.kind === "tracking"
            ? request.targets.includes(track.trackId)
            : track.className === request.className),
      );
      if (request.kind === "photo" && request.className !== "human") {
        const photo = selectPetPhotoRegions(request.tracks, request.className);
        if (photo.reason)
          return {
            kind: "enrollment" as const,
            candidates: [],
            reason: photo.reason,
          };
      }
      const samples = [];
      const candidates = [];
      let qualityRejected = 0;
      for (const track of tracks.slice(0, identityCapacity.targetsPerFrame)) {
        if (
          request.tracks.some(
            (other) =>
              other.trackId !== track.trackId &&
              other.className !== "human" &&
              iou(track.measuredBox, other.measuredBox) > 0,
          )
        ) {
          qualityRejected++;
          continue;
        }
        const result = await sample(
          request.rgb,
          track,
          request.kind !== "tracking",
        );
        if (!result) qualityRejected++;
        else if (request.kind === "tracking")
          samples.push({
            ...result,
            trackId: track.trackId,
            className: track.className,
          });
        else if (result.image)
          candidates.push({ ...result, image: result.image });
      }
      return request.kind === "tracking"
        ? { kind: "result" as const, samples, qualityRejected }
        : {
            kind: "enrollment" as const,
            candidates,
            reason: candidates.length
              ? null
              : "宠物过小或画面模糊，请使用清晰照片",
          };
    },
    close: () => session.release(),
  };
}
