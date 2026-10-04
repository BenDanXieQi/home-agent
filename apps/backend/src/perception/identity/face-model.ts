import { prepareOpenCv } from "./opencv-runtime";
import cv from "@techstark/opencv-js";
import { estimate } from "nudged";
import { InferenceSession, Tensor } from "onnxruntime-node";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  identityCapacity,
  identityFeatureSchema,
} from "@home-agent/api/contracts";
import type { identityRequestSchema } from "./protocol";
import models from "./models.json";
import profile from "./profile.json";
import { faceAlignment } from "./processing-version";

function owners(
  face: Float32Array,
  tracks: Extract<
    z.infer<typeof identityRequestSchema>,
    { kind: "tracking" }
  >["tracks"],
) {
  return tracks
    .filter(
      ({ measuredBox: box, className }) =>
        className === "human" &&
        box.x <= face[0]! + face[2]! / 2 &&
        face[0]! + face[2]! / 2 <= box.x + box.w &&
        box.y <= face[1]! + face[3]! / 2 &&
        face[1]! + face[3]! / 2 <= box.y + box.h,
    )
    .map((track) => track.trackId);
}

function rejected(reason: string) {
  return { kind: "enrollment" as const, candidates: [], reason };
}

let detectorFileCreated = false;

export async function createFaceModel(directory: string) {
  await prepareOpenCv();
  sharp.concurrency(1);
  for (const [name, spec] of Object.entries({
    yunet: models.models.yunet,
    sface: models.models.sface,
  })) {
    for (const [file, hash] of [
      [spec.file, spec.sha256],
      [spec.licenseFile, spec.licenseSha256],
    ] as const) {
      const bytes = await readFile(join(directory, file));
      if (createHash("sha256").update(bytes).digest("hex") !== hash)
        throw new Error(
          `Identity model or license fingerprint mismatch: ${file}`,
        );
      if (name === "yunet" && file === spec.file && !detectorFileCreated) {
        cv.FS_createDataFile("/", file, bytes, true, false, false);
        detectorFileCreated = true;
      }
    }
  }
  // The upstream JS build exports this class, but its npm declarations omit it.
  // Validate the actual native boundary rather than inventing a second CV API.
  const detectorConstructor: unknown = Reflect.get(cv, "FaceDetectorYN");
  if (typeof detectorConstructor !== "function")
    throw new Error("OpenCV.js FaceDetectorYN is unavailable");
  const detector = z
    .instanceof(Object)
    .parse(
      Reflect.construct(detectorConstructor, [
        `/${models.models.yunet.file}`,
        "",
        new cv.Size(profile.width, profile.height),
        profile.detectorScore,
        profile.nms,
        profile.topK,
        0,
        0,
      ]),
    );
  const detect = z
    .function({
      input: [z.instanceof(cv.Mat), z.instanceof(cv.Mat)],
      output: z.number(),
    })
    .parse(Reflect.get(detector, "detect"))
    .bind(detector);
  const disposeDetector = z
    .function({ input: [], output: z.void() })
    .parse(Reflect.get(detector, "delete"))
    .bind(detector);
  const session = await InferenceSession.create(
    join(directory, models.models.sface.file),
    {
      executionProviders: ["cpu"],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      executionMode: "sequential",
    },
  ).catch((cause: unknown) => {
    disposeDetector();
    throw cause;
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (
    !inputName ||
    !outputName ||
    session.inputNames.length !== 1 ||
    session.outputNames.length !== 1
  ) {
    disposeDetector();
    await session.release();
    throw new Error("SFace requires one input and one output");
  }

  async function extractFace(
    image: cv.Mat,
    face: Float32Array,
    minimumSharpness: number,
    includeImage: boolean,
  ) {
    if (
      face[14]! < profile.detectorScore ||
      Math.min(face[2]!, face[3]!) < profile.minimumFaceSide
    )
      return { face: null, reason: "人脸过小或检测置信度不足" };
    const transform = estimate({
      estimator: "TSR",
      domain: faceAlignment.landmarks.map((_, i) => ({
        x: face[4 + i * 2]!,
        y: face[5 + i * 2]!,
      })),
      range: faceAlignment.landmarks,
    });
    const matrix = cv.matFromArray(2, 3, cv.CV_64F, [
      transform.a,
      -transform.b,
      transform.x,
      transform.b,
      transform.a,
      transform.y,
    ]);
    const aligned = new cv.Mat();
    const gray = new cv.Mat();
    const laplacian = new cv.Mat();
    const mean = new cv.Mat();
    const deviation = new cv.Mat();
    const rgb = new cv.Mat();
    let blob: cv.Mat | undefined;
    try {
      cv.warpAffine(
        image,
        aligned,
        matrix,
        new cv.Size(112, 112),
        cv.INTER_LINEAR,
        cv.BORDER_CONSTANT,
        new cv.Scalar(),
      );
      cv.cvtColor(aligned, gray, cv.COLOR_BGR2GRAY);
      cv.Laplacian(gray, laplacian, cv.CV_64F, 1, 1, 0, cv.BORDER_DEFAULT);
      cv.meanStdDev(laplacian, mean, deviation);
      const sharpness = deviation.data64F[0]! ** 2;
      if (!Number.isFinite(sharpness) || sharpness < minimumSharpness)
        return { face: null, reason: "人脸模糊，请使用更清晰的画面" };
      // SFace's ONNX graph owns normalization; OpenCV's official feature API
      // supplies unscaled RGB float32 NCHW pixels, not values in [0, 1].
      blob = cv.blobFromImage(
        aligned,
        1,
        new cv.Size(112, 112),
        new cv.Scalar(),
        true,
        false,
        cv.CV_32F,
      );
      const tensor = new Tensor(
        "float32",
        new Float32Array(blob.data32F),
        [1, 3, 112, 112],
      );
      let outputs;
      try {
        outputs = await session.run({ [inputName!]: tensor });
      } finally {
        tensor.dispose();
      }
      let feature;
      try {
        const output = outputs[outputName!];
        if (
          !output ||
          output.type !== "float32" ||
          !(output.data instanceof Float32Array)
        )
          throw new Error("Invalid SFace output");
        feature = identityFeatureSchema.parse(Array.from(output.data));
      } finally {
        for (const output of Object.values(outputs)) output.dispose();
      }
      cv.cvtColor(aligned, rgb, cv.COLOR_BGR2RGB);
      const encoded = includeImage
        ? await sharp(Buffer.from(rgb.data), {
            raw: { width: 112, height: 112, channels: 3 },
          })
            .jpeg({ quality: 95 })
            .toBuffer()
        : undefined;
      return {
        face: {
          feature,
          sharpness,
          detectionScore: face[14]!,
          cropSha256: createHash("sha256").update(aligned.data).digest("hex"),
          ...(encoded ? { image: encoded.toString("base64") } : {}),
        },
        reason: null,
      };
    } finally {
      blob?.delete();
      for (const mat of [
        matrix,
        aligned,
        gray,
        laplacian,
        mean,
        deviation,
        rgb,
      ])
        mat.delete();
    }
  }

  async function extractFaces(request: z.infer<typeof identityRequestSchema>) {
    const rgb = cv.matFromArray(
      profile.height,
      profile.width,
      cv.CV_8UC3,
      request.rgb,
    );
    const image = new cv.Mat();
    const detected = new cv.Mat();
    try {
      cv.cvtColor(rgb, image, cv.COLOR_RGB2BGR);
      detect(image, detected);
      const faces = Array.from({ length: detected.rows }, (_, row) =>
        detected.data32F.slice(row * 15, (row + 1) * 15),
      );
      if (request.kind !== "tracking") {
        if (!faces.length) return rejected("未检测到人脸");
        if (request.kind === "photo" && faces.length !== 1)
          return rejected("照片中有多个人脸，请上传仅包含一个人的照片");
        const candidates = [];
        let reason: string | null = null;
        for (const face of faces
          .toSorted((a, b) => b[14]! - a[14]!)
          .slice(0, identityCapacity.targetsPerFrame)) {
          const result = await extractFace(
            image,
            face,
            request.minimumSharpness,
            true,
          );
          if (result.face?.image)
            candidates.push({ ...result.face, image: result.face.image });
          else reason = result.reason;
        }
        return {
          kind: "enrollment" as const,
          candidates,
          reason: candidates.length ? null : reason,
        };
      }
      const samples = [];
      const used = new Set<number>();
      let qualityRejected = 0;
      for (const face of faces.toSorted((a, b) => b[14]! - a[14]!)) {
        const targets = owners(face, request.tracks);
        if (
          face[14]! < profile.detectorScore ||
          Math.min(face[2]!, face[3]!) < profile.minimumFaceSide ||
          targets.length !== 1 ||
          used.has(targets[0]!)
        ) {
          qualityRejected++;
          continue;
        }
        const trackId = targets[0]!;
        used.add(trackId);
        if (!request.targets.includes(trackId)) continue;
        const result = await extractFace(
          image,
          face,
          request.minimumSharpness,
          false,
        );
        if (!result.face) qualityRejected++;
        else
          samples.push({
            trackId,
            className: "human" as const,
            // Local model diagnostics; the identity IPC schema strips this box.
            faceBox: { x: face[0]!, y: face[1]!, w: face[2]!, h: face[3]! },
            ...result.face,
          });
      }
      return { kind: "result" as const, samples, qualityRejected };
    } finally {
      for (const mat of [rgb, image, detected]) mat.delete();
    }
  }
  return {
    extract: extractFaces,
    async close() {
      disposeDetector();
      await session.release();
    },
  };
}
