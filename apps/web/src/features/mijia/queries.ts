import { queryOptions } from "@tanstack/react-query";
import { getMijiaState } from "./api";

export const mijiaStateQueryOptions = queryOptions({
  queryKey: ["mijia"],
  queryFn: ({ signal }) => getMijiaState(signal),
  staleTime: 1_000,
  retry: false,
  refetchInterval: (query) => {
    // Clamp transport hints to a practical browser polling interval.
    const delay = query.state.data?.pollAfterMs;
    return delay === undefined
      ? 5_000
      : Math.min(60_000, Math.max(1_000, delay));
  },
});
