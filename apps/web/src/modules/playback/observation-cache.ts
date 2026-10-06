import type { UseQueryResult } from "@tanstack/react-query";
import { windowListOptions } from "../perception/windows";
import { indexPlayableObservationWindows } from "./observation";

function selectWindows(data: {
  windows: Parameters<typeof indexPlayableObservationWindows>[0];
}) {
  return indexPlayableObservationWindows(data.windows);
}

export function observationWindowListOptions(
  source: Parameters<typeof windowListOptions>[0],
) {
  return { ...windowListOptions(source), select: selectWindows };
}

// Existing data does not confirm a cache miss while a refresh is fetching or paused.
export function observationCacheSettled(
  query: Pick<UseQueryResult, "isSuccess" | "fetchStatus"> | undefined,
) {
  return query?.isSuccess === true && query.fetchStatus === "idle";
}
