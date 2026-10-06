import { useEffect, useMemo, useState } from "react";
import { atom, useAtomValue } from "jotai";
import { useQueries } from "@tanstack/react-query";
import type { z } from "zod";
import { createPerceptionSourceState } from "../perception/source-state";
import {
  observationCacheSettled,
  observationWindowListOptions,
} from "./observation-cache";
import { recordingAvailabilityOptions } from "../recordings/api";
import {
  findObservationWindow,
  type observationPlaybackSourceSchema,
} from "./observation";

export function useObservationPlayback(
  activities: {
    id: string;
    windowId?: string | undefined;
    recordingAt?: number | undefined;
    source: z.infer<typeof observationPlaybackSourceSchema>;
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
      ...observationWindowListOptions({
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
            ? findObservationWindow(
                indexes[index]?.get(activity.source.sourceRunId) ?? [],
                activity.source,
                now,
                activity.windowId,
              )
            : undefined,
        ]),
      ),
  );
  const recordings = useQueries({
    queries: groups.map((group, index) => {
      const target = targets[index];
      // Refresh status gates execution, not the query identity or cached result.
      const at = [
        ...new Set(
          group.activities
            .filter((activity) => !matched[index]?.get(activity.id))
            .map(
              (activity) =>
                activity.recordingAt ?? activity.source.lastObservedAt,
            ),
        ),
      ];
      const options = recordingAvailabilityOptions(
        target?.scope_epoch === scope && at.length
          ? { ...target, at }
          : undefined,
      );
      return {
        ...options,
        queryKey: [...options.queryKey, JSON.stringify(group.state.target)],
        enabled:
          target?.scope_epoch === scope &&
          at.length > 0 &&
          observationCacheSettled(windows[index]),
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
      const windowQuery = windows[index];
      const qualified = targets[index]?.scope_epoch === scope;
      return group.activities.map((activity) => {
        const window = matched[index]?.get(activity.id);
        const clip =
          qualified && windowQuery?.isSuccess
            ? clips.get(activity.recordingAt ?? activity.source.lastObservedAt)
            : undefined;
        function availability() {
          if (!qualified) return { status: "waiting" as const };
          if (window) return { status: "window" as const, window };
          if (windowQuery?.isError && !windowQuery.isFetching)
            return {
              status: "failed" as const,
              error: windowQuery.error,
              retry: windowQuery.refetch,
            };
          if (!windowQuery?.isSuccess || windowQuery.fetchStatus !== "idle")
            return { status: "checking" as const };
          if (recording?.isError && !recording.isFetching)
            return {
              status: "failed" as const,
              error: recording.error,
              retry: recording.refetch,
            };
          if (clip)
            return {
              status: "recording" as const,
              clip,
              seekAt: activity.recordingAt ?? activity.source.lastObservedAt,
              checking: recording?.fetchStatus !== "idle",
            };
          if (
            recording?.data?.status === "unavailable" &&
            !recording.isFetching
          )
            return {
              status: "unavailable" as const,
              reason: recording.data.reason,
              retry: recording.refetch,
            };
          if (!recording?.isSuccess || recording.fetchStatus !== "idle")
            return { status: "checking" as const };
          return { status: "empty" as const };
        }
        return [activity.id, availability()] as const;
      });
    }),
  );
}
