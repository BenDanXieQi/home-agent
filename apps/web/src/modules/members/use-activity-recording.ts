import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import type { z } from "zod";
import { createPerceptionSourceState } from "../perception/source-state";
import { useRecordingPlayback } from "../recordings/use-recording-playback";
import {
  activityCacheSettled,
  activityWindowListOptions,
} from "./activity-cache";
import {
  findMemberActivityWindow,
  type memberActivitySourceSchema,
} from "./activity";

export function useActivityRecording(
  activity: z.infer<typeof memberActivitySourceSchema>,
  recordingAt: number,
) {
  const [openedAt] = useState(Date.now);
  const [source] = useState(() =>
    createPerceptionSourceState({
      deviceId: activity.deviceId,
      channel: activity.channel,
    }),
  );
  const target = useAtomValue(source.playbackTargetAtom);
  const windows = useQuery({
    ...activityWindowListOptions({
      scopeEpoch: target?.scope_epoch ?? "",
      ...source.target,
    }),
    enabled: !!target,
    refetchInterval: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const settled = activityCacheSettled(windows);
  const cached =
    target && settled
      ? findMemberActivityWindow(
          windows.data?.get(activity.sourceRunId) ?? [],
          activity,
          Math.max(openedAt, windows.dataUpdatedAt),
        )
      : undefined;
  const sdTarget = target && settled && !cached ? target : null;
  const playback = useRecordingPlayback(sdTarget);
  const { start } = playback;
  useEffect(() => {
    if (sdTarget) start({ kind: "clip", startAt: recordingAt });
  }, [sdTarget, recordingAt, start]);
  return {
    target,
    cached,
    ready: !!sdTarget,
    error: windows.error,
    retry: windows.refetch,
    playback,
  };
}
