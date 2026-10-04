import type { z } from "zod";
import { queryOptions, skipToken } from "@tanstack/react-query";
import {
  type mijiaRecordingPlaybackInputSchema,
  mijiaRecordingPlaybackStateSchema,
  mijiaRecordingAvailabilitySchema,
  type mijiaRecordingAvailabilityQuerySchema,
} from "@home-agent/api/mijia-recordings";
import {
  requestEmpty,
  requestJson,
  retryOnceOnTransportFailure,
} from "../../api/client";
import { RequestError } from "../../api/errors";

export type RecordingPlaybackInput = z.infer<
  typeof mijiaRecordingPlaybackInputSchema
>;
export type RecordingPlaybackState = z.infer<
  typeof mijiaRecordingPlaybackStateSchema
>;
export type RecordingTarget = Omit<RecordingPlaybackInput, "id" | "selection">;

function retryRead(failures: number, error: Error) {
  return (
    failures < 2 &&
    error instanceof RequestError &&
    (error.details.code === "network_error" ||
      error.details.code === "request_timeout")
  );
}

export function recordingPlaybackOptions(
  request: Pick<RecordingPlaybackInput, "scope_epoch" | "id"> | undefined,
) {
  return queryOptions({
    queryKey: ["recording-playback", request?.scope_epoch, request?.id],
    queryFn: request
      ? ({ signal }) =>
          requestJson(
            (client, options) =>
              client.api.mijia.recordings.playback[":id"].$get(
                { param: { id: request.id } },
                options,
              ),
            mijiaRecordingPlaybackStateSchema,
            { signal },
          )
      : skipToken,
    retry: retryRead,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      !query.state.error &&
      query.state.data?.state === "preparing" &&
      query.state.data.expiresAt > Date.now()
        ? 1000
        : false,
  });
}

export function prepareRecordingPlayback(
  input: RecordingPlaybackInput,
  signal: AbortSignal,
) {
  return requestJson(
    (client, options) =>
      client.api.mijia.recordings.playback[":id"].$put(
        { param: { id: input.id }, json: input },
        options,
      ),
    mijiaRecordingPlaybackStateSchema,
    { signal, retry: retryOnceOnTransportFailure },
  );
}

export function releaseRecordingPlayback(id: string) {
  return requestEmpty(
    (client, options) =>
      client.api.mijia.recordings.playback[":id"].$delete(
        { param: { id } },
        options,
      ),
    { keepalive: true, retry: retryOnceOnTransportFailure },
  );
}

export function recordingAvailabilityOptions(
  input: z.infer<typeof mijiaRecordingAvailabilityQuerySchema> | undefined,
) {
  return queryOptions({
    queryKey: ["recording-availability", input],
    queryFn: input
      ? ({ signal }) =>
          requestJson(
            (client, options) =>
              client.api.mijia.recordings.availability.$post(
                { json: input },
                options,
              ),
            mijiaRecordingAvailabilitySchema,
            { signal },
          )
      : skipToken,
    retry: false,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
