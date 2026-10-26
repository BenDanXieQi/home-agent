import type { InferRequestType } from "hono/client";
import type { BackendClient } from "@home-agent/backend-client";
import { queryOptions, skipToken } from "@tanstack/react-query";
import { requestJson, requestRecordingMedia } from "../../api/client";

export type RecordingMediaInput = InferRequestType<
  BackendClient["api"]["recordings"]["media"]["$post"]
>["json"];

export function recordingRangesOptions(
  scope: string,
  target: Pick<RecordingMediaInput, "deviceId" | "channel">,
) {
  return queryOptions({
    queryKey: ["recording-ranges", scope, target],
    queryFn: ({ signal }) =>
      requestJson(
        (client, options) =>
          client.api.recordings.ranges.$post({ json: target }, options),
        undefined,
        { signal },
      ),
    retry: false,
    gcTime: 0,
    refetchInterval: 10_000,
  });
}

export function originalMediaOptions(
  scope: string,
  input: RecordingMediaInput | undefined,
) {
  return queryOptions({
    queryKey: ["recording-media", scope, input],
    queryFn: input
      ? ({ signal }) =>
          requestRecordingMedia(
            (client, options) =>
              client.api.recordings.media.$post({ json: input }, options),
            { signal, timeoutMs: null },
          )
      : skipToken,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
