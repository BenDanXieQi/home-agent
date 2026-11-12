import { useEffect, useState } from "react";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  mediaAnalysisEntrySchema,
  mediaAnalysisSnapshotSchema,
  mediaAgentHistoryPageSchema,
} from "@home-agent/backend-client";
import { apiErrorSchema } from "@home-agent/api/contracts";
import { requestJson } from "../../api/client";
import { RequestError } from "../../api/errors";
import { requestErrorMessage } from "../../messages/zh-CN";

export type AnalysisEntry = z.infer<typeof mediaAnalysisEntrySchema>;
export type AnalysisSummary = z.infer<
  typeof mediaAnalysisSnapshotSchema
>["entries"][number];
export type MediaAgentHistoryPage = z.infer<typeof mediaAgentHistoryPageSchema>;
export type MediaAgentHistoryEntry = MediaAgentHistoryPage["entries"][number];

export function mediaAgentHistoryOptions(before: string | null) {
  return infiniteQueryOptions({
    queryKey: ["dynamics", "agent-history", before],
    initialPageParam: before,
    queryFn: ({ pageParam, signal }) =>
      requestJson(
        (client, options) =>
          client.api.dynamics["agent-history"].$get(
            { query: pageParam === null ? {} : { before: pageParam } },
            options,
          ),
        mediaAgentHistoryPageSchema,
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: false,
    staleTime: Infinity,
    retry: false,
    gcTime: 0,
  });
}

function useAnalysisStream<T>(path: string, schema: z.ZodType<T>) {
  const [state, setState] = useState<{
    data?: T;
    connected: boolean;
    error?: string;
  }>({ connected: false });
  useEffect(() => {
    const stream = new EventSource(path);
    const receive = (event: MessageEvent<string>) => {
      try {
        const data = schema.parse(JSON.parse(event.data));
        setState({ data, connected: true });
        if (event.type === "result") stream.close();
      } catch (error) {
        setState((previous) => ({
          ...previous,
          connected: false,
          error: requestErrorMessage(error),
        }));
        stream.close();
      }
    };
    stream.addEventListener("progress", receive);
    stream.addEventListener("result", receive);
    stream.addEventListener("error", (event) => {
      let message = "实时连接已中断，正在重新连接…";
      if (event instanceof MessageEvent) {
        const parsed = apiErrorSchema.safeParse(JSON.parse(event.data));
        if (parsed.success)
          message = requestErrorMessage(new RequestError(parsed.data));
      }
      setState((previous) => ({
        ...previous,
        connected: false,
        error: message,
      }));
    });
    return () => stream.close();
  }, [path, schema]);
  return state;
}

export function useDynamicsSnapshot() {
  return useAnalysisStream("/api/dynamics/stream", mediaAnalysisSnapshotSchema);
}

export function useAnalysisDetail(id: string) {
  return useAnalysisStream(
    `/api/dynamics/${encodeURIComponent(id)}/stream`,
    mediaAnalysisEntrySchema,
  );
}
