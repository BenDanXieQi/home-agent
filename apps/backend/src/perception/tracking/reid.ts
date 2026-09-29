import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { InferenceSession, Tensor } from "onnxruntime-node";
import type { z } from "zod";
import type { reidRequestSchema } from "./reid-protocol";

export const reidSha256 =
  "dc70121835336bcd342be0d3f5baba350e94c605b8da886a6efd2f3357fa3f29";
export async function createReid() {
  const bytes = await readFile(
    new URL("../../../models/human_body_reid_v2.onnx", import.meta.url),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== reidSha256)
    throw new Error("ReID model fingerprint mismatch");
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
      output.type !== "float32" ||
      JSON.stringify(input.shape) !== "[1,3,192,96]" ||
      output.name !== "head/out_emb:0" ||
      JSON.stringify(output.shape) !== "[1,1,1,128]"
    )
      throw new Error("ReID tensor contract mismatch");
    return {
      metadata: { sha256: reidSha256, input, output, provider: "cpu" as const },
      async extract(request: z.infer<typeof reidRequestSchema>) {
        const features: number[][] = [];
        for (const box of request.boxes) {
          const { frame } = request;
          if (box.x + box.w > frame.width || box.y + box.h > frame.height)
            throw new Error("ReID crop exceeds original frame");
          const rgb = await sharp(frame.rgb, {
            raw: { width: frame.width, height: frame.height, channels: 3 },
          })
            .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
            .resize(96, 192, { fit: "fill", kernel: "linear" })
            .raw()
            .toBuffer();
          const data = new Float32Array(3 * 192 * 96);
          for (let p = 0; p < 192 * 96; p++)
            for (let c = 0; c < 3; c++)
              data[c * 192 * 96 + p] = rgb[p * 3 + 2 - c]!;
          const tensor = new Tensor("float32", data, [1, 3, 192, 96]);
          const outputs = await session
            .run({ [input.name]: tensor })
            .finally(() => tensor.dispose());
          try {
            const result = outputs[output.name];
            if (
              !result ||
              result.type !== "float32" ||
              JSON.stringify(result.dims) !== "[1,1,1,128]"
            )
              throw new Error("Invalid ReID output");
            if (!(result.data instanceof Float32Array))
              throw new Error("ReID output must be float32 data");
            const vector = Array.from(result.data);
            const norm = Math.hypot(...vector);
            if (!Number.isFinite(norm) || norm <= 0)
              throw new Error("Invalid ReID feature norm");
            features.push(vector.map((v) => v / norm));
          } finally {
            for (const value of Object.values(outputs)) value.dispose();
          }
        }
        return features;
      },
      close: () => session.release(),
    };
  } catch (error) {
    await session.release();
    throw error;
  }
}
