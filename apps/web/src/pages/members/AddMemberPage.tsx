import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { BackLink } from "../../components/BackLink";
import { useMemberMutation } from "../../modules/members/use-member-mutation";
import { memberReadyAtom } from "../../modules/members/state";
import { Notice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import { MemberAccess } from "./MemberAccess";
import { MemberForm } from "./MemberForm";

function AddMember({ scope }: { scope: string }) {
  const ready = useAtomValue(memberReadyAtom);
  const navigate = useNavigate();
  const mutation = useMemberMutation(scope);
  function cancel() {
    navigate({ to: "/members", search: { member: undefined } }).catch(
      (error: unknown) => {
        console.error("Member navigation failed", error);
      },
    );
  }
  return (
    <div className="mx-auto max-w-3xl pb-8 pt-2 md:pt-4">
      <BackLink
        activeOptions={{ exact: true }}
        to="/members"
        search={{ member: undefined }}
        className="-ml-2 mb-7"
        disabled={mutation.isPending}
      >
        返回家庭成员
      </BackLink>
      {mutation.isError ? (
        <Notice tone="error">
          {requestErrorMessage(mutation.error)}。可返回成员页核实保存结果。
        </Notice>
      ) : null}
      <MemberForm
        member={null}
        pending={mutation.isPending}
        disabled={!ready}
        onSave={(id, profile) => {
          mutation.mutate(
            {
              scope_epoch: scope,
              id,
              profile,
              operation: "create",
            },
            {
              onSuccess: (_data, command) => {
                navigate({
                  to: "/members",
                  search: { member: command.id },
                  replace: true,
                }).catch((error: unknown) => {
                  console.error("Member navigation failed", error);
                });
              },
            },
          );
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
