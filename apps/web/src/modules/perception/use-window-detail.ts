import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  windowDetailOptions,
  windowRequestUnavailable,
  type WindowListEntry,
} from "./windows";
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
  // Frame judgments are frozen. Only completed speech can add historical evidence.
  const window = useMemo(
    () =>
      query.data && entry
        ? {
            ...query.data,
            inputState: entry.inputState,
            sampledMedia: entry.sampledMedia,
            summaryUntil: entry.summaryUntil,
          }
        : undefined,
    [query.data, entry],
  );
  return { query, window };
}
