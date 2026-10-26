import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import type { z } from "zod";
import { createPerceptionSourceState } from "../perception/source-state";
import { useRecordingPlayback } from "../recordings/use-recording-playback";
import { recordingRangesOptions } from "../recordings/originals";
import { householdScopeEpochAtom } from "../household/state";
import type { observationPlaybackSourceSchema } from "./observation";

export function useObservationRecording(
  activity: z.infer<typeof observationPlaybackSourceSchema>,
  recordingAt: number,
  seekAt: number,
) {
  const [source] = useState(() => createPerceptionSourceState(activity));
  const target = useAtomValue(source.playbackTargetAtom);
  const accessible = useAtomValue(source.accessibleAtom);
  const scope = useAtomValue(householdScopeEpochAtom);
  const ranges = useQuery({
    ...recordingRangesOptions(scope ?? "", source.target),
    enabled: accessible && !!scope,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const local = ranges.data?.ranges.some(
    (range) => range.start <= seekAt && seekAt < range.end,
  );
  const sdTarget = !ranges.isPending && !local ? target : null;
  const playback = useRecordingPlayback(sdTarget);
  const { start } = playback;
  useEffect(() => {
    if (sdTarget) start({ kind: "clip", startAt: recordingAt });
  }, [sdTarget, recordingAt, start]);
  return {
    target,
    local,
    ready: !!sdTarget,
    playback,
  };
}
