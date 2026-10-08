import type { UseQueryResult } from "@tanstack/react-query";
import { cachedWindowListOptions } from "../perception/windows";
import { indexPlayableObservationWindows } from "./observation";

function selectWindows(data: {
  windows: Parameters<typeof indexPlayableObservationWindows>[0];
}) {
  return indexPlayableObservationWindows(data.windows);
}

export function observationWindowListOptions(
  source: Parameters<typeof cachedWindowListOptions>[0],
) {
  return { ...cachedWindowListOptions(source), select: selectWindows };
}

// Existing data does not confirm a cache miss while a refresh is fetching or paused.
export function observationCacheSettled(
  query: Pick<UseQueryResult, "isSuccess" | "fetchStatus"> | undefined,
) {
  return query?.isSuccess === true && query.fetchStatus === "idle";
}
