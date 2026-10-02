import type { z } from "zod";
import {
  windowSpeechSegmentLimit,
  type windowSummarySchema,
  type speechObservationSchema,
} from "@home-agent/api/contracts";
import type { perceptionConfigSchema } from "../config";
import { speechDeliveryDeadline } from "../speech/limits";

export function createWindowSpeech(
  config: Pick<
    z.infer<typeof perceptionConfigSchema>,
    "speech" | "maxFrameAgeMs"
  >,
  endedAt: number,
) {
  return {
    enabled: config.speech.enabled,
    acceptingUntil: config.speech.enabled
      ? speechDeliveryDeadline(endedAt, config.maxFrameAgeMs)
      : endedAt,
    segments: [] as z.infer<typeof speechObservationSchema>[],
    truncated: false,
  } satisfies z.infer<typeof windowSummarySchema>["speech"];
}

export function appendWindowSpeech(
  window: Pick<
    z.infer<typeof windowSummarySchema>,
    "startedAt" | "endedAt" | "audio" | "speech"
  >,
  observation: z.infer<typeof speechObservationSchema>,
  now: number,
) {
  const { audio, speech } = window;
  if (
    !speech.enabled ||
    now >= speech.acceptingUntil ||
    !audio.run ||
    audio.startedAt === null ||
    audio.endedAt === null ||
    audio.run.trackRunId !== observation.run.trackRunId ||
    audio.run.scopeEpoch !== observation.run.scopeEpoch ||
    audio.run.deviceId !== observation.run.deviceId ||
    audio.generation !== observation.generation ||
    Math.max(window.startedAt, audio.startedAt, observation.observedStartAt) >=
      Math.min(window.endedAt, audio.endedAt, observation.observedEndAt) ||
    !observation.text.trim() ||
    speech.segments.some((segment) => segment.id === observation.id)
  )
    return false;
  if (speech.segments.length >= windowSpeechSegmentLimit) {
    if (speech.truncated) return false;
    speech.truncated = true;
    return true;
  }
  speech.segments.push(structuredClone(observation));
  speech.segments.sort((a, b) => a.startSample - b.startSample);
  return true;
}
