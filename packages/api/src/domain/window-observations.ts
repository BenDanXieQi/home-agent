import type { z } from "zod";
import type { windowDetailSchema } from "../contracts/perception-window";

export function projectWindowMaterial(
  window: Pick<
    z.infer<typeof windowDetailSchema>,
    "revision" | "inputState" | "sampledMedia" | "speech" | "audio"
  >,
) {
  const petSounds = window.audio.petSounds;
  return {
    revision: window.revision,
    inputState: window.inputState,
    sampledMedia: window.sampledMedia
      ? structuredClone(window.sampledMedia)
      : null,
    speech_count: window.speech.segments.length,
    speech_enabled: window.speech.enabled,
    pet_sound_analysis: petSounds
      ? { status: petSounds.status, validity: petSounds.validity }
      : null,
    pet_sound_count:
      petSounds?.status === "ready" && petSounds.validity === "valid"
        ? petSounds.chunks.reduce(
            (count, chunk) => count + chunk.detections.length,
            0,
          )
        : null,
  };
}
