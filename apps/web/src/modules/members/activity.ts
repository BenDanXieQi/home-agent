import { z } from "zod";
import type { WindowListEntry } from "../perception/windows";

export const memberActivitySourceSchema = z.object({
  deviceId: z.string().min(1),
  channel: z.union([z.literal(1), z.literal(2)]),
  sourceRunId: z.uuid(),
  firstObservedAt: z.number().finite(),
  lastObservedAt: z.number().finite(),
});

// Sort once per query update and share the run index across all activity rows.
export function indexPlayableMemberActivityWindows(windows: WindowListEntry[]) {
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

export function findMemberActivityWindow(
  windows: WindowListEntry[],
  activity: Pick<
    z.infer<typeof memberActivitySourceSchema>,
    "sourceRunId" | "firstObservedAt" | "lastObservedAt"
  >,
  now: number,
) {
  return windows.find(
    (entry) =>
      entry.sampledMedia &&
      entry.sampledMedia.readableUntil > now &&
      entry.videoRun?.runId === activity.sourceRunId &&
      entry.startedAt <= activity.lastObservedAt &&
      activity.firstObservedAt <= entry.endedAt,
  );
}

export function findPlayableMemberActivityWindow(
  windows: WindowListEntry[],
  activity: Parameters<typeof findMemberActivityWindow>[1],
  now: number,
) {
  return findMemberActivityWindow(
    indexPlayableMemberActivityWindows(windows).get(activity.sourceRunId) ?? [],
    activity,
    now,
  );
}
