import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OfflineRecognizer } from "sherpa-onnx-node/non-streaming-asr.js";
import { speechObservationSchema } from "@home-agent/api/contracts";
import { senseVoiceModel, speechLimits } from "./limits";

async function verify(path: URL, expected: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expected)
    throw new Error(`Speech asset fingerprint mismatch: ${path.pathname}`);
}
export async function createSpeechModel() {
  const modelPath = new URL(
    "../../../models/sensevoice/model.int8.onnx",
    import.meta.url,
  );
  const tokensPath = new URL(
    "../../../models/sensevoice/tokens.txt",
    import.meta.url,
  );
  await verify(modelPath, senseVoiceModel.sha256);
  await verify(tokensPath, senseVoiceModel.tokensSha256);
  const recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: speechLimits.sampleRate, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: fileURLToPath(modelPath),
        language: "auto",
        useInverseTextNormalization: 1,
      },
      tokens: fileURLToPath(tokensPath),
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
  });
  return {
    recognize(samples: Float32Array) {
      const start = performance.now();
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: speechLimits.sampleRate, samples });
      recognizer.decode(stream);
      const text = speechObservationSchema.shape.text.parse(
        recognizer.getResult(stream).text,
      );
      return { text, elapsedMs: performance.now() - start };
    },
  };
}
