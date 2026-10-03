import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useStore } from "jotai";
import type {
  memberSaveSchema,
  memberDeleteSchema,
} from "@home-agent/api/household-members";
import { RequestError } from "../../api/errors";
import { deleteMember, memberListOptions, saveMember } from "./queries";
import { memberReadyAtom, memberScopeAtom } from "./state";

/** Cache coordination belongs to members; mounted pages own navigation. */
export function useMemberMutation(scope: string) {
  const client = useQueryClient();
  const store = useStore();
  const queryKey = memberListOptions(scope).queryKey;
  return useMutation({
    gcTime: 0,
    mutationFn: (
      command:
        | ReturnType<typeof memberSaveSchema.parse>
        | (ReturnType<typeof memberDeleteSchema.parse> & {
            operation: "delete";
          }),
    ) => {
      if (
        !store.get(memberReadyAtom) ||
        store.get(memberScopeAtom) !== command.scope_epoch ||
        command.scope_epoch !== scope
      )
        throw new RequestError({ code: "request_cancelled" });
      return command.operation === "delete"
        ? deleteMember(command.scope_epoch, command.id)
        : saveMember(command);
    },
    onMutate: async () => {
      await client.cancelQueries({ queryKey });
    },
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey });
      if (store.get(memberScopeAtom) !== scope) return;
      client.setQueryData(queryKey, data);
      await client.invalidateQueries({
        queryKey: ["household-context", { scope_epoch: scope }],
      });
    },
  });
}
