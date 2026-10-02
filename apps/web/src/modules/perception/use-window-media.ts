import { useEffect, useRef } from "react";
import {
  isCancelledError,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  requestWindowMedia,
  windowMediaOptions,
  windowRequestUnavailable,
  type WindowMediaSelection,
} from "./windows";
import { RequestError } from "../../api/errors";

export function useWindowMedia(
  scope: string,
  id: string,
  selection: WindowMediaSelection,
  active: boolean,
) {
  const client = useQueryClient();
  const options = windowMediaOptions(scope, id, selection);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!active) controller.current?.abort();
    return () => {
      controller.current?.abort();
    };
  }, [active]);
  const mutation = useMutation({
    mutationFn: async (retry: boolean) => {
      controller.current?.abort();
      const pending = new AbortController();
      controller.current = pending;
      await client.cancelQueries({ queryKey: options.queryKey });
      pending.signal.throwIfAborted();
      try {
        return await requestWindowMedia(
          id,
          { ...selection, retry },
          pending.signal,
        );
      } catch (cause) {
        pending.signal.throwIfAborted();
        if (
          !(cause instanceof RequestError) ||
          cause.status !== undefined ||
          !["network_error", "request_timeout", "invalid_response"].includes(
            cause.details.code,
          )
        )
          throw cause;
        // A lost response does not undo server-side encoding. Reconcile by reading,
        // never by automatically issuing another generation request.
        const current = await client.fetchQuery(options);
        pending.signal.throwIfAborted();
        if (current.state === "not_generated" || current.state === "failed")
          throw cause;
        return current;
      }
    },
    onSuccess: (data) => {
      if (!controller.current?.signal.aborted)
        client.setQueryData(options.queryKey, data);
    },
    retry: false,
    gcTime: 0,
  });
  const query = useQuery({
    ...options,
    // A completed product is now owned by the preview. Server expiry must not
    // replace its metadata and unmount the locally downloaded media.
    enabled: (cached) =>
      active &&
      !mutation.isPending &&
      !windowRequestUnavailable(mutation.error) &&
      !windowRequestUnavailable(cached.state.error) &&
      cached.state.data?.state !== "ready",
  });
  const mutationError =
    isCancelledError(mutation.error) ||
    (mutation.error instanceof DOMException &&
      mutation.error.name === "AbortError")
      ? null
      : mutation.error;
  const error =
    query.error ??
    (query.data?.state === "not_generated" || query.data?.state === "failed"
      ? mutationError
      : null);
  return { query, mutation, error };
}
