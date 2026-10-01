import { queryOptions } from "@tanstack/react-query";
import {
  memberListSchema,
  type memberSaveSchema,
} from "@home-agent/api/household-members";
import { requestJson } from "../../api/client";

export type Member = ReturnType<
  typeof memberListSchema.parse
>["members"][number];

export function memberListOptions(scope: string) {
  return queryOptions({
    queryKey: ["household-members", scope],
    queryFn: ({ signal }) =>
      requestJson(
        (api, options) =>
          api.api["household-members"].list.$post(
            { json: { scope_epoch: scope } },
            options,
          ),
        memberListSchema,
        { signal },
      ),
    retry: false,
    gcTime: 0,
  });
}

export function saveMember(input: ReturnType<typeof memberSaveSchema.parse>) {
  return requestJson(
    (api, options) =>
      api.api["household-members"].save.$post({ json: input }, options),
    memberListSchema,
  );
}

export function deleteMember(scope: string, id: string) {
  return requestJson(
    (api, options) =>
      api.api["household-members"].delete.$post(
        { json: { scope_epoch: scope, id } },
        options,
      ),
    memberListSchema,
  );
}
