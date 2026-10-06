import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import {
  agentReceiptIndexSchema,
  agentCurrentContextSchema,
} from "@home-agent/api/agent-receipts";
import { requestJson } from "../../api/client";

export function useReceiptIndex() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["agent-receipts"],
    queryFn: async ({ signal, queryKey }) => {
      const previous =
        queryClient.getQueryData<z.infer<typeof agentReceiptIndexSchema>>(
          queryKey,
        );
      const update = await requestJson(
        (client, options) =>
          client.api.agent.receipts.$get(
            {
              query: previous
                ? {
                    journal_id: previous.journal_id,
                    after_sequence: previous.total_received,
                  }
                : {},
            },
            options,
          ),
        agentReceiptIndexSchema,
        { signal },
      );
      return {
        ...update,
        receipts:
          previous?.journal_id === update.journal_id &&
          previous.total_received <= update.total_received
            ? [
                ...update.receipts,
                ...previous.receipts.filter(
                  (receipt) =>
                    receipt.sequence >= update.first_retained_sequence,
                ),
              ]
            : update.receipts,
      };
    },
    refetchInterval: 2000,
    retry: false,
    gcTime: 0,
  });
}
export function useReceivedContext(journalId: string) {
  return useQuery({
    queryKey: ["agent-current-context", journalId],
    queryFn: async ({ signal }) => {
      const data = await requestJson(
        (client, options) =>
          client.api.agent.receipts.current.$get({}, options),
        agentCurrentContextSchema,
        { signal },
      );
      if (data.journal_id !== journalId) throw new Error("接收会话已变化");
      return data.context;
    },
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
}
