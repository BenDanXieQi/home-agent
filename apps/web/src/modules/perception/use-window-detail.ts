import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { windowDetailOptions, windowRequestUnavailable } from "./windows";
import {
  useWindowInputState,
  useWindowMediaState,
} from "./use-window-input-state";
export function useWindowDetail(
  id: string | undefined,
  scope: string,
  active: boolean,
) {
  const query = useQuery({
    ...windowDetailOptions(scope, id),
    enabled: (cached) =>
      active && !!id && !windowRequestUnavailable(cached.state.error),
    refetchInterval: (cached) =>
      !cached.state.error && cached.state.data?.analysisAcceptingUntil != null
        ? 1000
        : false,
  });
  const inputState = useWindowInputState(query.data);
  const mediaState = useWindowMediaState(query.data?.sampledMedia);
  const window = useMemo(
    () =>
      query.data && inputState !== undefined
        ? {
            ...query.data,
            inputState,
            sampledMedia:
              query.data.sampledMedia && mediaState
                ? { ...query.data.sampledMedia, state: mediaState }
                : null,
          }
        : undefined,
    [query.data, inputState, mediaState],
  );
  return { query, window };
}
