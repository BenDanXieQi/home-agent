import { useMemo } from "react";
import { atom, useAtomValue } from "jotai";
import { useQueries } from "@tanstack/react-query";
import type { z } from "zod";
import { createPerceptionSourceState } from "../perception/source-state";
import { recordingAvailabilityOptions } from "../recordings/api";
import type { observationPlaybackSourceSchema } from "./observation";
import { recordingRangesOptions } from "../recordings/originals";

export function useObservationPlayback(
  activities: {
    id: string;
    windowId?: string | undefined;
    recordingAt?: number | undefined;
    source: z.infer<typeof observationPlaybackSourceSchema>;
  }[],
  scope: string,
) {
  const groupSignature = useMemo(
    () =>
      JSON.stringify([
        ...new Map(
          activities.map(({ source }) => [
            JSON.stringify([source.deviceId, source.channel]),
            [source.deviceId, source.channel],
          ]),
        ).values(),
      ]),
    [activities],
  );
  const groupSources = useMemo(() => {
    const parsed: unknown = JSON.parse(groupSignature);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (
        !Array.isArray(item) ||
        typeof item[0] !== "string" ||
        (item[1] !== 1 && item[1] !== 2)
      )
        return [];
      return [
        {
          key: JSON.stringify(item),
          deviceId: item[0],
          channel: item[1],
        },
      ];
    });
  }, [groupSignature]);
  const groupStates = useMemo(() => {
    const sources = new Map<
      string,
      {
        key: string;
        state: ReturnType<typeof createPerceptionSourceState>;
      }
    >();
    for (const { key, deviceId, channel } of groupSources) {
      sources.set(key, {
        key,
        state: createPerceptionSourceState({ deviceId, channel }),
      });
    }
    return [...sources.values()];
  }, [groupSources]);
  const groups = useMemo(
    () =>
      groupStates.map((group) => ({
        ...group,
        activities: activities.filter(
          ({ source }) =>
            JSON.stringify([source.deviceId, source.channel]) === group.key,
        ),
      })),
    [activities, groupStates],
  );
  const targetsAtom = useMemo(
    () =>
      atom((get) =>
        groupStates.map((group) => ({
          accessible: get(group.state.accessibleAtom),
          target: get(group.state.playbackTargetAtom),
        })),
      ),
    [groupStates],
  );
  const targets = useAtomValue(targetsAtom);
  const ranges = useQueries({
    queries: groups.map((group, index) => ({
      ...recordingRangesOptions(scope, group.state.target),
      enabled: targets[index]?.accessible === true,
    })),
  });
  const local = groups.map(
    (group, index) =>
      new Set(
        group.activities
          .filter((activity) => {
            const at = activity.recordingAt ?? activity.source.lastObservedAt;
            return ranges[index]?.data?.ranges.some(
              (range) => range.start <= at && at < range.end,
            );
          })
          .map((activity) => activity.id),
      ),
  );
  const recordings = useQueries({
    queries: groups.map((group, index) => {
      const target = targets[index]?.target;
      const at = [
        ...new Set(
          group.activities
            .filter((activity) => !local[index]?.has(activity.id))
            .map(
              (activity) =>
                activity.recordingAt ?? activity.source.lastObservedAt,
            ),
        ),
      ];
      return {
        ...recordingAvailabilityOptions(
          target?.scope_epoch === scope && at.length
            ? { ...target, at }
            : undefined,
        ),
        enabled:
          target?.scope_epoch === scope &&
          at.length > 0 &&
          ranges[index]?.isPending === false,
      };
    }),
  });
  return new Map(
    groups.flatMap((group, index) => {
      const query = ranges[index];
      const recording = recordings[index];
      const clips = new Map(
        recording?.isSuccess && recording.data?.status === "ready"
          ? recording.data.matches.map((match) => [match.at, match.clip])
          : [],
      );
      return group.activities.map((activity) => {
        function availability() {
          if (!targets[index]?.accessible)
            return { status: "waiting" as const };
          if (local[index]?.has(activity.id))
            return {
              status: "local" as const,
              seekAt: activity.recordingAt ?? activity.source.lastObservedAt,
            };
          if (query?.isPending) return { status: "checking" as const };
          if (recording?.isError)
            return {
              status: "failed" as const,
              error: recording.error,
              retry: recording.refetch,
            };
          const clip = clips.get(
            activity.recordingAt ?? activity.source.lastObservedAt,
          );
          if (clip)
            return {
              status: "recording" as const,
              clip,
              seekAt: activity.recordingAt ?? activity.source.lastObservedAt,
              checking: recording?.isFetching ?? false,
            };
          if (recording?.data?.status === "unavailable")
            return {
              status: "unavailable" as const,
              reason: recording.data.reason,
              retry: recording.refetch,
            };
          if (targets[index]?.target && !recording?.isSuccess)
            return { status: "checking" as const };
          if (query?.isError)
            return {
              status: "failed" as const,
              error: query.error,
              retry: query.refetch,
            };
          return { status: "empty" as const };
        }
        return [activity.id, availability()] as const;
      });
    }),
  );
}
