import { useEffect, useMemo, useState } from "react";
import { atom, useAtomValue } from "jotai";
import { useQueries } from "@tanstack/react-query";
import type { z } from "zod";
import { createPerceptionSourceState } from "../perception/source-state";
import {
  activityCacheSettled,
  activityWindowListOptions,
} from "./activity-cache";
import { recordingAvailabilityOptions } from "../recordings/api";
import {
  findMemberActivityWindow,
  type memberActivitySourceSchema,
} from "./activity";

export function useActivityPlayback(
  activities: {
    id: string;
    source: z.infer<typeof memberActivitySourceSchema>;
  }[],
  scope: string,
) {
  const groups = useMemo(() => {
    const sources = new Map<
      string,
      {
        state: ReturnType<typeof createPerceptionSourceState>;
        activities: typeof activities;
      }
    >();
    for (const activity of activities) {
      const { deviceId, channel } = activity.source;
      const key = JSON.stringify([deviceId, channel]);
      let group = sources.get(key);
      if (!group) {
        group = {
          state: createPerceptionSourceState({ deviceId, channel }),
          activities: [],
        };
        sources.set(key, group);
      }
      group.activities.push(activity);
    }
    return [...sources.values()];
  }, [activities]);
  const targetsAtom = useMemo(
    () =>
      atom((get) => groups.map((group) => get(group.state.playbackTargetAtom))),
    [groups],
  );
  const targets = useAtomValue(targetsAtom);
  const windows = useQueries({
    queries: groups.map((group, index) => ({
      ...activityWindowListOptions({
        scopeEpoch: scope,
        ...group.state.target,
      }),
      enabled: targets[index]?.scope_epoch === scope,
    })),
  });
  const [clock, setClock] = useState(Date.now);
  const now = Math.max(clock, ...windows.map((query) => query.dataUpdatedAt));
  const indexes = windows.map((query) => query.data);
  const nextExpiry = Math.min(
    ...indexes.flatMap((runs) =>
      [...(runs?.values() ?? [])].flatMap((entries) =>
        entries.flatMap((entry) =>
          entry.sampledMedia && entry.sampledMedia.readableUntil > now
            ? [entry.sampledMedia.readableUntil]
            : [],
        ),
      ),
    ),
  );
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return undefined;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.max(0, nextExpiry - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [nextExpiry]);
  const matched = groups.map(
    (group, index) =>
      new Map(
        group.activities.map((activity) => [
          activity.id,
          targets[index]?.scope_epoch === scope && windows[index]?.isSuccess
            ? findMemberActivityWindow(
                indexes[index]?.get(activity.source.sourceRunId) ?? [],
                activity.source,
                now,
              )
            : undefined,
        ]),
      ),
  );
  const recordings = useQueries({
    queries: groups.map((group, index) => {
      const target = targets[index];
      const at = activityCacheSettled(windows[index])
        ? [
            ...new Set(
              group.activities
                .filter((activity) => !matched[index]?.get(activity.id))
                .map((activity) => activity.source.lastObservedAt),
            ),
          ]
        : [];
      const options = recordingAvailabilityOptions(
        target?.scope_epoch === scope && at.length
          ? { ...target, at }
          : undefined,
      );
      return {
        ...options,
        queryKey: [...options.queryKey, JSON.stringify(group.state.target)],
        enabled: target?.scope_epoch === scope && at.length > 0,
      };
    }),
  });
  return new Map(
    groups.flatMap((group, index) => {
      const recording = recordings[index];
      const clips = new Map(
        recording?.isSuccess && recording.data?.status === "ready"
          ? recording.data.matches.map((match) => [match.at, match.clip])
          : [],
      );
      return group.activities.map(
        (activity) =>
          [
            activity.id,
            {
              window: matched[index]?.get(activity.id),
              clip:
                targets[index]?.scope_epoch === scope &&
                activityCacheSettled(windows[index])
                  ? clips.get(activity.source.lastObservedAt)
                  : undefined,
              checking: !!recording?.isFetching || !!windows[index]?.isFetching,
            },
          ] as const,
      );
    }),
  );
}
