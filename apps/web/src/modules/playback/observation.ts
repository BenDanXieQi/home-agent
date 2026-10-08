import type { z } from "zod";
import { memberActivityDataSchema } from "@home-agent/api/contracts";
import type { WindowListEntry } from "../perception/windows";

export const observationPlaybackSourceSchema = memberActivityDataSchema.pick({
  deviceId: true,
  channel: true,
  sourceRunId: true,
  firstObservedAt: true,
  lastObservedAt: true,
});

export function memberObservationPlaybackSource(
  data: z.infer<typeof memberActivityDataSchema>,
) {
  const current = data.attribution.current;
  // A revocation can originate from a different camera. Replay the target's
  // previous attribution evidence, not the remote revocation timestamp.
  const evidence =
    current.kind === "known"
      ? current
      : (data.attribution.lastCorrection?.before ?? data.attribution.original);
  const observedAt =
    evidence.kind === "known"
      ? evidence.association.observedAt
      : data.lastObservedAt;
  return observationPlaybackSourceSchema.parse({
    ...data,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
  });
}

// Sort once per query update and share the run index across all activity rows.
export function indexPlayableObservationWindows(windows: WindowListEntry[]) {
  const runs = new Map<string, WindowListEntry[]>();
  for (const entry of windows.toSorted((a, b) => b.startedAt - a.startedAt)) {
    if (
      !entry.videoRun ||
      entry.sampledMedia?.state !== "ready" ||
      !["video", "crop_video"].includes(
        entry.sampledMedia.selection.representation,
      )
    )
      continue;
    const entries = runs.get(entry.videoRun.runId) ?? [];
    entries.push(entry);
    runs.set(entry.videoRun.runId, entries);
  }
  return runs;
}

export function findObservationWindow(
  windows: WindowListEntry[],
  activity: Pick<
    z.infer<typeof observationPlaybackSourceSchema>,
    "sourceRunId" | "firstObservedAt" | "lastObservedAt"
  >,
  now: number,
  windowId?: string,
) {
  return windows.find(
    (entry) =>
      (windowId === undefined || entry.id === windowId) &&
      entry.sampledMedia &&
      entry.sampledMedia.readableUntil > now &&
      entry.videoRun?.runId === activity.sourceRunId &&
      entry.startedAt <= activity.lastObservedAt &&
      activity.firstObservedAt <= entry.endedAt,
  );
}

export function findPlayableObservationWindow(
  windows: WindowListEntry[],
  activity: Parameters<typeof findObservationWindow>[1],
  now: number,
  windowId?: string,
) {
  return findObservationWindow(
    indexPlayableObservationWindows(windows).get(activity.sourceRunId) ?? [],
    activity,
    now,
    windowId,
  );
}
