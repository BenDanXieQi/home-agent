import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";

// Called only during worker initialization, alongside native model loading.
export async function fingerprintModel(path: string) {
  const modelPath = resolve(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(modelPath)) hash.update(chunk);
  return { modelPath, sha256: hash.digest("hex") };
}
