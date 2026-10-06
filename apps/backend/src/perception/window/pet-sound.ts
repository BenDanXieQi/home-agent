import type { z } from "zod";
import type {
  petSoundObservationSchema,
  windowSummarySchema,
} from "@home-agent/api/contracts";
import { matchesWindowAudio } from "./audio-observation";

export function appendWindowPetSound(
  window: z.infer<typeof windowSummarySchema>,
  observation: z.infer<typeof petSoundObservationSchema>,
  now: number,
  acceptingUntil: number,
) {
  // Ownership is (startedAt, endedAt]; sample tolerance only applies to coverage.
  const analysis = window.audio.petSounds;
  if (
    !analysis ||
    now >= acceptingUntil ||
    !matchesWindowAudio(window, observation) ||
    observation.observedEndAt <= window.startedAt ||
    observation.observedEndAt > window.endedAt ||
    observation.observedStartAt <
      (window.audio.startedAt ?? Infinity) - 1 / 16 ||
    observation.observedEndAt > (window.audio.endedAt ?? -Infinity) + 1 / 16 ||
    analysis.chunks.some((chunk) => chunk.id === observation.id) ||
    analysis.chunks.length >= 8
  )
    return false;
  analysis.status = "ready";
  analysis.validity = "valid";
  analysis.modelSha256 = observation.modelSha256;
  delete analysis.error;
  analysis.chunks.push(structuredClone(observation));
  analysis.chunks.sort((a, b) => a.startSample - b.startSample);
  return true;
}
