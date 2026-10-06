import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { petSoundPolicy } from "./limits";

export const petSoundModelSha256 =
  "69304b8a1b96bbe6b7d16c24079f0732c65faf3568a14cb82a8238c709afe76c";
const labelsSha256 =
  "cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429";

async function verify(path: URL, expected: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expected)
    throw new Error(`Pet sound asset fingerprint mismatch: ${path.pathname}`);
}

export async function createPetSoundModel() {
  const model = new URL(
    "../../../models/pet-sounds/model.int8.onnx",
    import.meta.url,
  );
  const labels = new URL(
    "../../../models/pet-sounds/class_labels_indices.csv",
    import.meta.url,
  );
  await verify(model, petSoundModelSha256);
  await verify(labels, labelsSha256);
  const { AudioTagging } = await import("sherpa-onnx-node/audio-tagg.js");
  const tagger = new AudioTagging({
    model: {
      zipformer: { model: fileURLToPath(model) },
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    labels: fileURLToPath(labels),
    topK: 527,
  });
  return {
    classify(samples: Float32Array) {
      const stream = tagger.createStream();
      stream.acceptWaveform({ sampleRate: petSoundPolicy.sampleRate, samples });
      const events = tagger.compute(stream, 527);
      return events.map((event) => ({ label: event.name, score: event.prob }));
    },
  };
}
