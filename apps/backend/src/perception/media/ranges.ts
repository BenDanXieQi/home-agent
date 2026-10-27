import type { z } from "zod";
import type { agentContextDataSchemas } from "@home-agent/api/agent-context";
import type { projectWindowObservation } from "../window/observation";
import type { createRecordingsService } from "../../recordings/service";
import { windowLimits } from "../window/limits";

export function projectMediaRanges(
  windows: ReturnType<typeof projectWindowObservation>[],
  recordings: Pick<ReturnType<typeof createRecordingsService>, "covers">,
  now = Date.now(),
) {
  const groups = Map.groupBy(
    windows.filter((window) => window.candidate !== "none"),
    (window) =>
      JSON.stringify([
        window.run.runId,
        window.videoRun?.runId,
        window.run.deviceId,
        window.run.channel,
        window.audioAvailable,
        window.audioRun?.trackRunId,
        window.audioGeneration,
      ]),
  );
  const ranges: z.infer<
    typeof agentContextDataSchemas.observations
  >["media_ranges"] = [];

  for (const group of groups.values()) {
    let current: (typeof ranges)[number] | undefined;
    for (const window of group.toSorted((a, b) => a.startedAt - b.startedAt)) {
      const audio = window.material.sampledMedia;
      const readableUntil = audio?.readableUntil ?? window.summaryUntil;
      const audioReady = !window.audioAvailable || audio?.state === "ready";
      const settledAt =
        window.endedAt + windowLimits.durationMs + windowLimits.graceMs + 1;
      if (current && window.startedAt <= current.endedAt) {
        if (window.candidate === "video") current.kind = "video";
        current.endedAt = Math.max(current.endedAt, window.endedAt);
        current.settledAt = Math.max(current.settledAt, settledAt);
        current.readableUntil = Math.min(current.readableUntil, readableUntil);
        current.ready &&= audioReady;
      } else {
        current = {
          id: window.id,
          source: {
            deviceId: window.run.deviceId,
            channel: window.run.channel,
          },
          startedAt: window.startedAt,
          endedAt: window.endedAt,
          kind: window.candidate === "video" ? "video" : "audio",
          includeAudio: window.audioAvailable,
          readableUntil,
          settledAt,
          ready: audioReady,
        };
        ranges.push(current);
      }
    }
  }

  for (const range of ranges) {
    range.ready &&=
      now >= range.settledAt &&
      (range.kind !== "video" ||
        recordings.covers({
          ...range.source,
          start: range.startedAt,
          end: range.endedAt,
        }));
  }
  return ranges
    .filter((range) => range.readableUntil > now)
    .toSorted((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}
