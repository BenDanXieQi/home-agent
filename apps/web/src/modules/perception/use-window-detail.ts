import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  windowDetailOptions,
  windowRequestUnavailable,
  type WindowListEntry,
} from "./windows";
import {
  useWindowInputState,
  useWindowMediaState,
} from "./use-window-input-state";
export function useWindowDetail(
  entry: WindowListEntry | undefined,
  scope: string,
  active: boolean,
) {
  const query = useQuery({
    ...windowDetailOptions(scope, entry?.id),
    enabled: (cached) =>
      active && !!entry && !windowRequestUnavailable(cached.state.error),
    refetchInterval: (cached) =>
      !cached.state.error &&
      cached.state.data &&
      cached.state.data.revision < (entry?.revision ?? 0)
        ? 500
        : false,
  });
  const inputState = useWindowInputState(entry);
  const mediaState = useWindowMediaState(entry?.sampledMedia);
  // Frame judgments are frozen. Only completed speech can add historical evidence.
  const window = useMemo(
    () =>
      query.data && entry && inputState !== undefined
        ? {
            ...query.data,
            inputState,
            sampledMedia:
              entry.sampledMedia && mediaState
                ? { ...entry.sampledMedia, state: mediaState }
                : null,
            summaryUntil: entry.summaryUntil,
          }
        : undefined,
    [query.data, entry, inputState, mediaState],
  );
  return { query, window };
}
