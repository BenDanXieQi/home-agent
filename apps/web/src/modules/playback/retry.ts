import { RequestError } from "../../api/errors";
import type { PlaybackSession } from "./session";

/** Retry transient playback failures at most three times per viewing attempt. */
export function playbackRetryDelay(
  failure: ReturnType<PlaybackSession["getSnapshot"]>["failure"],
  attempts: number,
) {
  if (attempts >= 3) return undefined;
  const transient =
    failure instanceof RequestError
      ? failure.status !== undefined
        ? failure.status === 408 ||
          failure.status === 429 ||
          failure.status >= 500
        : [
            "network_error",
            "request_timeout",
            "ice_gathering_timeout",
          ].includes(failure.details.code)
      : failure !== null &&
        [
          "negotiation_timeout",
          "track_ended",
          "connection_failed",
          "first_frame_timeout",
          "stalled_frame",
        ].includes(failure);
  return transient ? 2000 * 2 ** attempts : undefined;
}
