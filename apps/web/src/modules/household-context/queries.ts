import { queryOptions } from "@tanstack/react-query";
import {
  contextBrowseResponseSchema,
  type contextBrowseQuerySchema,
} from "@home-agent/api/household-context";
import { requestJson } from "../../api/client";

export function contextBrowseOptions(
  input: ReturnType<typeof contextBrowseQuerySchema.parse>,
) {
  return queryOptions({
    queryKey: ["household-context", input],
    queryFn: async ({ signal }) => ({
      request: input,
      ...(await requestJson(
        (client, options) =>
          client.api["household-context"].browse.$post(
            { json: input },
            options,
          ),
        contextBrowseResponseSchema,
        { signal },
      )),
    }),
    gcTime: 0,
    retry: false,
  });
}
