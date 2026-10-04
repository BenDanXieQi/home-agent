import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RequestError } from "../../api/errors";
import {
  prepareRecordingPlayback,
  recordingPlaybackOptions,
  releaseRecordingPlayback,
  type RecordingPlaybackInput,
  type RecordingTarget,
} from "./api";

export function useRecordingPlayback(target: RecordingTarget | null) {
  const client = useQueryClient();
  const owner = useRef<{
    input: RecordingPlaybackInput;
    controller: AbortController;
  } | null>(null);
  const mutation = useMutation({
    mutationFn: (input: RecordingPlaybackInput) => {
      const current = owner.current;
      if (!current || current.input !== input)
        throw new RequestError({ code: "request_cancelled" });
      return prepareRecordingPlayback(input, current.controller.signal);
    },
    onSuccess: (result, input) => {
      if (owner.current?.input === input)
        client.setQueryData(recordingPlaybackOptions(input).queryKey, result);
    },
    retry: false,
    gcTime: 0,
  });
  const request = mutation.variables;
  const query = useQuery({
    ...recordingPlaybackOptions(request),
    // A lost PUT response is recovered by GET for the same resource ID.
    enabled: !!target && !!request && !mutation.isPending,
  });
  const [now, setNow] = useState(Date.now);
  const expiresAt = query.data?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return undefined;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const release = useCallback(() => {
    const current = owner.current;
    owner.current = null;
    if (!current) return;
    current.controller.abort();
    // TanStack owns cancellation failures and always resolves this Promise.
    // oxlint-disable-next-line typescript/no-floating-promises
    client.cancelQueries({
      queryKey: recordingPlaybackOptions(current.input).queryKey,
    });
    releaseRecordingPlayback(current.input.id).catch((error: unknown) =>
      console.warn("Recording playback release failed", error),
    );
  }, [client]);

  const { reset } = mutation;
  const cancel = useCallback(() => {
    release();
    reset();
  }, [release, reset]);

  useEffect(() => release, [release]);
  useEffect(() => {
    const input = owner.current?.input;
    if (
      input &&
      (!target ||
        input.scope_epoch !== target.scope_epoch ||
        input.revision !== target.revision ||
        input.deviceId !== target.deviceId ||
        input.channel !== target.channel)
    )
      cancel();
  }, [target, cancel]);

  function start(selection: RecordingPlaybackInput["selection"]) {
    if (!target) return;
    release();
    const current = {
      input: { ...target, id: crypto.randomUUID(), selection },
      controller: new AbortController(),
    };
    owner.current = current;
    mutation.mutate(current.input);
  }

  return {
    request,
    state: query.data,
    pending: mutation.isPending || (!!request && query.isPending),
    error: query.error ?? (!query.data ? mutation.error : null),
    expired: expiresAt !== undefined && now >= expiresAt,
    refresh: query.refetch,
    start,
    cancel,
  };
}
