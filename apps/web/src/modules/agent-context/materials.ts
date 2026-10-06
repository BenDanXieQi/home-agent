import { queryOptions, useQueries } from "@tanstack/react-query";
import type { z } from "zod";
import {
  agentMaterialResponseSchema,
  type agentContextScopeSchema,
  type agentObservationSchema,
} from "@home-agent/api/agent-context";
import { requestJson } from "../../api/client";

/** Each retained source owns its availability and retry state. */
export function useObservationMaterials(
  scope: z.infer<typeof agentContextScopeSchema>,
  record: z.infer<typeof agentObservationSchema>,
) {
  const references = [
    ...record.member_sighting_ids.map((id) => ({
      kind: "member_sighting" as const,
      id,
    })),
    ...(record.window_id
      ? [{ kind: "perception_window" as const, id: record.window_id }]
      : []),
  ];
  const queries = useQueries({
    queries: references.map((reference) =>
      queryOptions({
        queryKey: [
          "agent-observation-material",
          scope,
          reference.kind,
          reference.id,
          reference.kind === "member_sighting"
            ? record.member_sighting_revisions[reference.id]
            : record.window_material,
        ],
        queryFn: async ({ signal }) => {
          const response = await requestJson(
            (client, options) =>
              client.api.agent.context.material.$post(
                { json: { scope, ...reference } },
                options,
              ),
            agentMaterialResponseSchema,
            { signal },
          );
          if (
            response.kind !== reference.kind ||
            response.scope.scope_epoch !== scope.scope_epoch ||
            response.scope.account_id !== scope.account_id ||
            response.scope.home_id !== scope.home_id ||
            (response.kind === "member_sighting"
              ? response.record.id
              : response.window.id) !== reference.id
          )
            throw new Error("引用读取结果不匹配");
          return response;
        },
        retry: false,
        gcTime: 0,
        staleTime: Infinity,
      }),
    ),
  });
  return queries.map((query, index) => ({
    reference: references[index]!,
    query,
  }));
}
