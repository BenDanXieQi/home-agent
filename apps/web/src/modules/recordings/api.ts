import type { z } from "zod";
import {
  infiniteQueryOptions,
  queryOptions,
  skipToken,
} from "@tanstack/react-query";
import {
  mijiaRecordingIndexSchema,
  type mijiaRecordingPlaybackInputSchema,
  mijiaRecordingPlaybackStateSchema,
  type mijiaRecordingQuerySchema,
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

export function recordingIndexOptions(
  target: RecordingTarget,
  from: number,
  until: number,
) {
  return infiniteQueryOptions({
    queryKey: ["camera-recordings", target, from, until],
    initialPageParam: from,
    queryFn: ({ pageParam, signal }) =>
      readRecordingIndex({ ...target, afterMs: pageParam, limit: 200 }, signal),
    getNextPageParam: (page) =>
      page.status === "ready" &&
      page.nextAfterMs !== null &&
      page.nextAfterMs < until
        ? page.nextAfterMs
        : undefined,
    retry: retryRead,
    gcTime: 0,
    staleTime: 30_000,
  });
}

function readRecordingIndex(
  input: z.infer<typeof mijiaRecordingQuerySchema>,
  signal: AbortSignal,
) {
  return requestJson(
    (client, options) =>
      client.api.mijia.cameras.recordings.$post({ json: input }, options),
    mijiaRecordingIndexSchema,
    { signal, timeoutMs: 25_000 },
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
