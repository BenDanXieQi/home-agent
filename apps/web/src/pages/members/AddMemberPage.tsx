import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { saveMember, memberListOptions } from "../../modules/members/queries";
import { Notice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import { MemberAccess } from "./MemberAccess";
import { MemberForm } from "./MemberForm";

function AddMember({ scope }: { scope: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: saveMember,
    onMutate: async () => {
      await client.cancelQueries({
        queryKey: memberListOptions(scope).queryKey,
      });
    },
    onSuccess: async (data, command) => {
      await client.cancelQueries({
        queryKey: memberListOptions(scope).queryKey,
      });
      client.setQueryData(memberListOptions(scope).queryKey, data);
      await client.invalidateQueries({ queryKey: ["household-context"] });
      await navigate({
        to: "/members",
        search: { member: command.id },
        replace: true,
      });
    },
  });
  function cancel() {
    navigate({ to: "/members", search: { member: undefined } }).catch(
      (error: unknown) => {
        console.error("Member navigation failed", error);
      },
    );
  }
  return (
    <div className="mx-auto max-w-3xl pb-8 pt-2 md:pt-4">
      {!mutation.isPending ? (
        <Link
          to="/members"
          search={{ member: undefined }}
          className="mb-7 inline-flex items-center gap-2 py-2 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft size={16} />
          返回家庭成员
        </Link>
      ) : null}
      {mutation.isError ? (
        <Notice tone="error">
          {requestErrorMessage(mutation.error)}。可返回成员页核实保存结果。
        </Notice>
      ) : null}
      <MemberForm
        member={null}
        pending={mutation.isPending}
        onSave={(id, profile) => {
          mutation.mutate({
            scope_epoch: scope,
            id,
            profile,
            operation: "create",
          });
        }}
        onCancel={cancel}
        onDelete={undefined}
      />
    </div>
  );
}

export default function AddMemberPage() {
  return (
    <MemberAccess>
      {(scope) => <AddMember key={scope} scope={scope} />}
    </MemberAccess>
  );
}
