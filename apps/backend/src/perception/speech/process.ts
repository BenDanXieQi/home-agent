import { createAudioInferenceProcess } from "../audio/inference-process";
import { speechResponseSchema, speechJobSchema } from "./protocol";
import { speechLimits, senseVoiceModel } from "./limits";

export function createSpeechProcess() {
  return createAudioInferenceProcess({
    entry: new URL(
      import.meta.url.endsWith(".ts")
        ? "./process-entry.ts"
        : "../speech/process-entry.js",
      import.meta.url,
    ),
    result: speechResponseSchema.options[1],
    job: speechJobSchema,
    modelSha256: senseVoiceModel.sha256,
    limits: speechLimits,
  });
}
