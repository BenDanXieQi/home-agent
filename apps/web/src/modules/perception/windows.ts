import { z } from "zod";
import { queryOptions, skipToken } from "@tanstack/react-query";
import {
  windowListSchema,
  mediaViewSchema,
  type mediaRequestSchema,
  type mediaSelectionSchema,
  windowDetailSchema,
  type windowListQuerySchema,
  type windowListEntrySchema,
} from "@home-agent/api/contracts";
import { requestJson, requestBlob } from "../../api/client";
import { RequestError } from "../../api/errors";

export type PerceptionWindow = z.infer<typeof windowDetailSchema>;
export type WindowListEntry = z.infer<typeof windowListEntrySchema>;
export type WindowMarker = z.infer<typeof windowListSchema>["markers"][number];
export type WindowListCursor = NonNullable<
  z.infer<typeof windowListSchema>["next"]
>;
export type WindowMediaSelection = z.infer<typeof mediaSelectionSchema>;

export function windowRequestUnavailable(error: unknown) {
  return (
    error instanceof RequestError &&
    (error.status === 404 || error.status === 410)
  );
}

export function windowQueryScope(scope: string) {
  return ["perception-windows", scope] as const;
}

const windowQueryPolicy = {
  gcTime: 0,
  retry: (failureCount: number, error: Error) =>
    failureCount < 3 &&
    (error instanceof RequestError && error.status !== undefined
      ? error.status === 408 || error.status === 429 || error.status >= 500
      : error instanceof RequestError &&
        (error.details.code === "network_error" ||
          error.details.code === "request_timeout")),
};

export function windowListOptions({
  scopeEpoch,
  deviceId,
  channel,
  ...range
}: z.infer<typeof windowListQuerySchema>) {
  const source = { scopeEpoch, deviceId, channel, ...range };
  const latest =
    range.before === undefined &&
    range.start === undefined &&
    range.end === undefined;
  return queryOptions({
    ...windowQueryPolicy,
    staleTime: latest ? 0 : Infinity,
    queryKey: [...windowQueryScope(source.scopeEpoch), "list", source],
    queryFn: ({ signal }) =>
      requestJson(
        (client, options) =>
          client.api.perception.windows.$get(
            {
              query: {
                scopeEpoch,
                deviceId,
                channel: String(channel),
                ...(range.before === undefined ? {} : { before: range.before }),
                ...(range.beforeId ? { beforeId: range.beforeId } : {}),
                ...(range.start === undefined ? {} : { start: range.start }),
                ...(range.end === undefined ? {} : { end: range.end }),
              },
            },
            options,
          ),
        windowListSchema,
        { signal },
      ),
    refetchInterval: (query) => (latest && !query.state.error ? 4000 : false),
  });
}

export function windowDetailOptions(scope: string, id: string | undefined) {
  return queryOptions({
    ...windowQueryPolicy,
    queryKey: [...windowQueryScope(scope), "detail", id],
    queryFn:
      id === undefined
        ? skipToken
        : ({ signal }) =>
            requestJson(
              (client, options) =>
                client.api.perception.windows[":id"].$get(
                  { param: { id } },
                  options,
                ),
              windowDetailSchema,
              { signal },
            ),
    staleTime: (query) =>
      query.state.data?.analysisAcceptingUntil != null ? 0 : Infinity,
  });
}

export function windowMediaOptions(
  scope: string,
  id: string,
  selection: WindowMediaSelection,
) {
  return queryOptions({
    ...windowQueryPolicy,
    queryKey: [...windowQueryScope(scope), "media", id, selection],
    staleTime: 0,
    queryFn: ({ signal }) =>
      requestJson(
        (client, options) =>
          client.api.perception.windows[":id"].media[":representation"].$get(
            {
              param: { id, representation: selection.representation },
              query: { includeAudio: String(selection.includeAudio) },
            },
            options,
          ),
        mediaViewSchema,
        { signal },
      ),
    refetchInterval: (query) =>
      query.state.error
        ? false
        : query.state.data?.state === "generating"
          ? 500
          : false,
  });
}

export function windowBytesOptions(
  scope: string,
  id: string,
  selection: WindowMediaSelection,
  mediaId: string,
) {
  return queryOptions({
    ...windowQueryPolicy,
    queryKey: [...windowQueryScope(scope), "bytes", id, selection, mediaId],
    queryFn: ({ signal }) => readWindowMedia(id, selection, mediaId, signal),
    staleTime: Infinity,
  });
}

export function requestWindowMedia(
  id: string,
  input: z.infer<typeof mediaRequestSchema>,
  signal: AbortSignal,
) {
  return requestJson(
    (client, options) =>
      client.api.perception.windows[":id"].media.$post(
        { param: { id }, json: input },
        options,
      ),
    mediaViewSchema,
    { signal },
  );
}

function readWindowMedia(
  id: string,
  selection: WindowMediaSelection,
  mediaId: string,
  signal: AbortSignal,
) {
  return requestBlob(
    (client, options) =>
      client.api.perception.windows[":id"].media[":representation"][
        ":mediaId"
      ].$get(
        {
          param: { id, representation: selection.representation, mediaId },
          query: { includeAudio: String(selection.includeAudio) },
        },
        options,
      ),
    { signal },
  );
}
