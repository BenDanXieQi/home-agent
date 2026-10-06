import type { z } from "zod";
import type {
  audioObservationSchema,
  windowSummarySchema,
} from "@home-agent/api/contracts";

export function matchesWindowAudio(
  window: Pick<
    z.infer<typeof windowSummarySchema>,
    "startedAt" | "endedAt" | "audio"
  >,
  observation: z.infer<typeof audioObservationSchema>,
) {
  const { audio } = window;
  return (
    audio.run !== null &&
    audio.startedAt !== null &&
    audio.endedAt !== null &&
    audio.run.trackRunId === observation.run.trackRunId &&
    audio.run.scopeEpoch === observation.run.scopeEpoch &&
    audio.run.deviceId === observation.run.deviceId &&
    audio.generation === observation.generation &&
    Math.max(window.startedAt, audio.startedAt, observation.observedStartAt) <
      Math.min(window.endedAt, audio.endedAt, observation.observedEndAt)
  );
}
