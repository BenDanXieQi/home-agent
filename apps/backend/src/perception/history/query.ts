import {
  agentHistoryTimeDifference,
  type windowListQuerySchema,
  type windowSummarySchema,
  type perceptionWindowsHistoryQuerySchema,
  type windowMarkerSchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";

type Window = z.infer<typeof windowSummarySchema>;

export function compareWindowPosition(
  a: Pick<Window, "startedAt" | "id">,
  b: Pick<Window, "startedAt" | "id">,
) {
  return a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function matchesWindowMarker(
  entry: z.infer<typeof windowMarkerSchema>,
  query: z.infer<typeof windowListQuerySchema>,
) {
  return (
    (query.start === undefined || entry.endedAt > query.start) &&
    (query.end === undefined || entry.startedAt < query.end) &&
    (query.before === undefined ||
      entry.startedAt < query.before ||
      (entry.startedAt === query.before &&
        query.beforeId !== undefined &&
        entry.id < query.beforeId))
  );
}

export function windowMarkers(
  entries: readonly z.infer<typeof windowMarkerSchema>[],
) {
  const markers: z.infer<typeof windowMarkerSchema>[] = [];
  for (const entry of entries.toSorted(compareWindowPosition)) {
    const previous = markers.at(-1);
    if (previous && entry.startedAt <= previous.endedAt)
      previous.endedAt = Math.max(previous.endedAt, entry.endedAt);
    else
      markers.push({
        id: entry.id,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
      });
  }
  return markers;
}

export function createWindowHistoryMatcher(
  input: Pick<
    z.infer<typeof perceptionWindowsHistoryQuerySchema>,
    "start" | "end" | "sources"
  >,
) {
  const start = agentHistoryTimeDifference(input.start);
  const end = agentHistoryTimeDifference(input.end);
  const interval = (first: number, last: number) =>
    end(first) < 0 && start(last) >= 0;
  return {
    interval,
    matches(entry: Window) {
      return (
        (!input.sources ||
          input.sources.some(
            (source) =>
              source.device_id === entry.run.deviceId &&
              (source.channel === undefined ||
                source.channel === entry.run.channel),
          )) &&
        (interval(entry.startedAt, entry.endedAt) ||
          (entry.audio.run !== null &&
            entry.audio.startedAt !== null &&
            entry.audio.endedAt !== null &&
            interval(entry.audio.startedAt, entry.audio.endedAt)) ||
          entry.speech.segments.some((segment) =>
            interval(segment.observedStartAt, segment.observedEndAt),
          ))
      );
    },
  };
}
