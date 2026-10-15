import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

export const detectionModelPath = fileURLToPath(
  new URL("../../../models/det_4C.onnx", import.meta.url),
);

export async function fingerprintModel() {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(detectionModelPath))
    hash.update(chunk);
  return { modelPath: detectionModelPath, sha256: hash.digest("hex") };
}
