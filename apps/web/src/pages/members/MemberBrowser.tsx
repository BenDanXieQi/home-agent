import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { memberReadyAtom } from "../../modules/members/state";
import { useMemberMutation } from "../../modules/members/use-member-mutation";
import { Users, Plus, RefreshCw } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { memberListOptions, type Member } from "../../modules/members/queries";
import { Button } from "../../components/Button";
import { buttonStyles } from "../../components/button-styles";
import { Notice } from "../../components/Notice";
import { EmptyState } from "../../components/EmptyState";
import { PageHeaderContent } from "../../components/PageHeaderContent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { requestErrorMessage } from "../../messages/zh-CN";
import { MemberForm } from "./MemberForm";
import { MemberOverview } from "./MemberOverview";

export function MemberBrowser({ scope }: { scope: string }) {
  const ready = useAtomValue(memberReadyAtom);
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const options = memberListOptions(scope);
  const query = useQuery({ ...options, enabled: ready });
  const [editing, setEditing] = useState<Member | null>(null);
  const [deleting, setDeleting] = useState<Member | null>(null);
  const mutation = useMemberMutation(scope);
  const afterSave = {
    onSuccess: (
      data: NonNullable<typeof query.data>,
      command: NonNullable<typeof mutation.variables>,
    ) => {
      setEditing(null);
      setDeleting(null);
      navigate({
        to: "/members",
        search: {
          member:
            command.operation === "delete" ? data.members[0]?.id : command.id,
        },
        replace: true,
      }).catch((error: unknown) => {
        console.error("Member navigation failed", error);
      });
    },
  };
  const members = query.data?.members ?? [];
  const selected =
    members.find((member) => member.id === search.member) ?? members[0];
  function refresh() {
    if (!ready) return;
    query.refetch().catch((error: unknown) => {
      console.error("Member refresh failed", error);
    });
  }
  return (
    <>
      <PageHeaderContent slot="details">
        <span className="text-xs text-muted">
          {members.length > 0
            ? `${members.filter((member) => member.kind === "person").length} 人 · ${members.filter((member) => member.kind === "pet").length} 只宠物`
            : ""}
        </span>
      </PageHeaderContent>
      {selected ? (
        <SegmentedControl
          className="mb-5 border-b border-line"
          variant="underline"
          label="家庭成员"
          value={selected.id}
          disabled={!ready || !!editing || mutation.isPending}
          onValueChange={(member) => {
            mutation.reset();
            navigate({
              to: "/members",
              search: { member },
              replace: true,
            }).catch((error: unknown) => {
              console.error("Member navigation failed", error);
            });
          }}
          options={members.map((member) => ({
            value: member.id,
            label: member.name,
          }))}
        />
      ) : null}
      {selected ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted">成员资料</span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              aria-label="刷新成员资料"
              title="刷新成员资料"
              icon={<RefreshCw size={14} />}
              disabled={!ready || !!editing || mutation.isPending}
              status={query.isFetching ? "pending" : "idle"}
              onClick={refresh}
            />
            {!editing ? (
              <Link
                to="/members/new"
                className={`${buttonStyles.base} ${buttonStyles.secondary}`}
              >
                <Plus size={14} />
                添加成员
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
      {query.isError ? (
        <Notice tone="error">
          {requestErrorMessage(query.error)}
          <Button onClick={refresh}>重试</Button>
        </Notice>
      ) : null}
      {mutation.isError && !deleting ? (
        <Notice tone="error">
          {requestErrorMessage(mutation.error)}。可刷新资料核实保存结果。
        </Notice>
      ) : null}
      {query.isPending && !editing ? (
        <Skeleton className="h-64 rounded-2xl" aria-label="正在读取成员" />
      ) : null}
      {query.isSuccess && !selected && !editing ? (
        <EmptyState
          surface="plain"
          className="min-h-[55svh]"
          icon={<Users size={24} />}
          title="让家人和宠物拥有自己的资料"
          description="从添加第一位成员开始，记录称呼、外观与日常备注。"
        >
          <Link
            to="/members/new"
            className={`${buttonStyles.base} ${buttonStyles.primary}`}
          >
            <Plus size={14} />
            添加成员
          </Link>
        </EmptyState>
      ) : null}
      {selected || editing ? (
        editing ? (
          <MemberForm
            key={editing.id}
            member={editing}
            pending={mutation.isPending}
            disabled={!ready}
            onSave={(id, profile) => {
              mutation.mutate(
                {
                  scope_epoch: scope,
                  id,
                  profile,
                  operation: "update",
                },
                afterSave,
              );
            }}
            onCancel={() => {
              setEditing(null);
              mutation.reset();
            }}
            onDelete={() => {
              mutation.reset();
              setDeleting(editing);
            }}
          />
        ) : selected ? (
          <MemberOverview
            member={selected}
            scope={scope}
            onEdit={() => {
              mutation.reset();
              setEditing(selected);
            }}
          />
        ) : null
      ) : null}
      <AlertDialog.Root
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setDeleting(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-40 bg-ink/25" />
          <AlertDialog.Content
            className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-7 shadow-xl"
            onEscapeKeyDown={(event) => {
              if (mutation.isPending) event.preventDefault();
            }}
          >
            <AlertDialog.Title className="text-xl font-medium">
              删除「{deleting?.name}」？
            </AlertDialog.Title>
            <AlertDialog.Description className="mb-6 mt-3 text-sm leading-7 text-muted">
              成员资料将被移除，历史上下文保留。此操作无法撤销。
            </AlertDialog.Description>
            {mutation.isError ? (
              <Notice tone="error">
                {requestErrorMessage(mutation.error)}
              </Notice>
            ) : null}
            <div className="flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button disabled={mutation.isPending}>取消</Button>
              </AlertDialog.Cancel>
              <Button
                variant="primary"
                status={mutation.isPending ? "pending" : "idle"}
                disabled={!ready}
                onClick={() => {
                  if (deleting)
                    mutation.mutate(
                      {
                        scope_epoch: scope,
                        operation: "delete",
                        id: deleting.id,
                      },
                      afterSave,
                    );
                }}
              >
                确认删除
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
