import type { UseQueryResult } from "@tanstack/react-query";
import { windowListOptions } from "../perception/windows";
import { indexPlayableMemberActivityWindows } from "./activity";

function selectWindows(data: {
  windows: Parameters<typeof indexPlayableMemberActivityWindows>[0];
}) {
  return indexPlayableMemberActivityWindows(data.windows);
}

export function activityWindowListOptions(
  source: Parameters<typeof windowListOptions>[0],
) {
  return { ...windowListOptions(source), select: selectWindows };
}

// Existing data does not confirm a cache miss while a refresh is fetching or paused.
export function activityCacheSettled(
  query: Pick<UseQueryResult, "isSuccess" | "fetchStatus"> | undefined,
) {
  return query?.isSuccess === true && query.fetchStatus === "idle";
}
