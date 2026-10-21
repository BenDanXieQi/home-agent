import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { InferenceSession, Tensor } from "onnxruntime-node";
import sharp from "sharp";
import type { z } from "zod";
import type { identityRequestSchema } from "./protocol";
import type { identityEvidenceSchema } from "./evidence";
import { iou } from "../tracking/assignment";
import frame from "./profile.json";
import profile from "../../../models/person-attributes/profile.json";

const personAttributeVersions = {
  modelVersion: profile.sha256,
  processingVersion: createHash("sha256")
    .update(JSON.stringify({ profile, sharp: sharp.versions.sharp }))
    .digest("hex"),
};

export async function createPersonAttributeModel() {
  sharp.concurrency(1);
  const [model, license] = await Promise.all([
    readFile(
      new URL("../../../models/person-attributes/model.onnx", import.meta.url),
    ),
    readFile(
      new URL("../../../models/person-attributes/LICENSE", import.meta.url),
    ),
  ]);
  if (
    createHash("sha256").update(model).digest("hex") !== profile.sha256 ||
    createHash("sha256").update(license).digest("hex") !== profile.licenseSha256
  )
    throw new Error("Person attribute asset fingerprint mismatch");

  const session = await InferenceSession.create(model, {
    executionProviders: ["cpu"],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: "sequential",
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const input = session.inputMetadata[0];
  const outputMetadata = session.outputMetadata[0];
  if (
    !inputName ||
    !outputName ||
    session.inputNames.length !== 1 ||
    session.outputNames.length !== 1 ||
    !input?.isTensor ||
    !outputMetadata?.isTensor ||
    input.type !== "float32" ||
    outputMetadata.type !== "float32" ||
    JSON.stringify(input.shape.slice(1)) !==
      JSON.stringify([3, profile.height, profile.width]) ||
    JSON.stringify(outputMetadata.shape.slice(1)) !== "[26]"
  ) {
    await session.release();
    throw new Error("Invalid PP-Human attribute tensor contract");
  }

  return {
    async extract(request: z.infer<typeof identityRequestSchema>) {
      if (request.kind !== "tracking")
        throw new Error("Person attributes require measured tracking targets");
      const attributes: NonNullable<
        z.infer<typeof identityEvidenceSchema>["attributes"]
      > = [];
      const humans = request.tracks.filter(
        (track) => track.className === "human",
      );
      for (const track of humans) {
        if (
          !request.targets.includes(track.trackId) ||
          humans.some(
            (other) =>
              other.trackId !== track.trackId &&
              iou(track.measuredBox, other.measuredBox) >= 0.3,
          )
        )
          continue;
        const box = track.measuredBox;
        const left = Math.max(0, Math.floor(box.x));
        const top = Math.max(0, Math.floor(box.y));
        const width = Math.min(
          frame.width - left,
          Math.ceil(box.x + box.w) - left,
        );
        const height = Math.min(
          frame.height - top,
          Math.ceil(box.y + box.h) - top,
        );
        if (width < profile.minimumWidth || height < profile.minimumHeight)
          continue;

        const rgb = await sharp(request.rgb, {
          raw: { width: frame.width, height: frame.height, channels: 3 },
        })
          .extract({ left, top, width, height })
          .resize(profile.width, profile.height, {
            fit: "fill",
            kernel: "linear",
          })
          .raw()
          .toBuffer();
        const pixels = profile.width * profile.height;
        const data = new Float32Array(pixels * 3);
        for (let p = 0; p < pixels; p++)
          for (let c = 0; c < 3; c++)
            data[c * pixels + p] =
              (rgb[p * 3 + c]! / 255 - profile.mean[c]!) / profile.std[c]!;
        const tensor = new Tensor("float32", data, [
          1,
          3,
          profile.height,
          profile.width,
        ]);
        let outputs;
        try {
          outputs = await session.run({ [inputName]: tensor });
        } finally {
          tensor.dispose();
        }
        try {
          const output = outputs[outputName];
          if (
            !output ||
            output.type !== "float32" ||
            !(output.data instanceof Float32Array) ||
            output.data.length !== 26
          )
            throw new Error("Invalid PP-Human attribute output");
          const femaleScore = output.data[22]!;
          if (
            !Number.isFinite(femaleScore) ||
            femaleScore < 0 ||
            femaleScore > 1
          )
            throw new Error("Invalid person gender score");
          const score = Math.max(femaleScore, 1 - femaleScore);
          if (score < profile.minimumScore) continue;
          attributes.push({
            trackId: track.trackId,
            gender: femaleScore > 0.5 ? "female" : "male",
            score,
            ...personAttributeVersions,
          });
        } finally {
          for (const output of Object.values(outputs)) output.dispose();
        }
      }
      return {
        kind: "result" as const,
        samples: [],
        attributes,
        qualityRejected: 0,
      };
    },
    close: () => session.release(),
  };
}
