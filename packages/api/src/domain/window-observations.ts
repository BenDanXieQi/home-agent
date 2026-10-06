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

export function projectWindowObservation(
  window: z.infer<typeof windowDetailSchema>,
) {
  return {
    id: window.id,
    run: { ...window.run },
    videoRun: window.videoRun ? { ...window.videoRun } : null,
    startedAt: window.startedAt,
    endedAt: window.endedAt,
    material: projectWindowMaterial(window),
    frames: window.frames.map((frame) => ({
      generation: frame.mediaTime.generation,
      receivedAt: frame.receivedAt,
      trackIds: frame.tracks?.map((track) => track.trackId) ?? [],
      // Body tracks retain the exact measured detection box. Head/face detections
      // can belong to an enclosing human track without being separate targets.
      untrackedTarget:
        frame.detections?.some((detection) => {
          const body = ["human", "cat", "dog"].includes(detection.className);
          const head =
            detection.className === "head" || detection.className === "face";
          if (!body && !head) return false;
          return !frame.tracks?.some((track) => {
            const box = track.measuredBox;
            if (!box) return false;
            if (body)
              return (
                track.className === detection.className &&
                box.x === detection.x &&
                box.y === detection.y &&
                box.w === detection.w &&
                box.h === detection.h
              );
            const x = detection.x + detection.w / 2;
            const y = detection.y + detection.h / 2;
            return (
              track.className === "human" &&
              x >= box.x &&
              x <= box.x + box.w &&
              y >= box.y &&
              y <= box.y + box.h
            );
          });
        }) ?? false,
    })),
    visualChanged: window.gate.visual === "changed",
    speech: window.speech.segments.length > 0,
    petSound:
      window.audio.petSounds?.status === "ready" &&
      window.audio.petSounds.chunks.some(
        (chunk) => chunk.detections.length > 0,
      ),
  };
}
