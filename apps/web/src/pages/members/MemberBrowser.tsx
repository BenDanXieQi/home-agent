import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Plus, RefreshCw } from "lucide-react";
import { AlertDialog } from "radix-ui";
import type { memberSaveSchema } from "@home-agent/api/household-members";
import {
  deleteMember,
  memberListOptions,
  saveMember,
  type Member,
} from "../../modules/members/queries";
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
  const client = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const options = memberListOptions(scope);
  const query = useQuery(options);
  const [editing, setEditing] = useState<Member | null>(null);
  const [deleting, setDeleting] = useState<Member | null>(null);
  const mutation = useMutation({
    mutationFn: (
      command:
        | ReturnType<typeof memberSaveSchema.parse>
        | { operation: "delete"; id: string },
    ) =>
      command.operation === "delete"
        ? deleteMember(scope, command.id)
        : saveMember(command),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: options.queryKey });
    },
    onSuccess: async (data, command) => {
      await client.cancelQueries({ queryKey: options.queryKey });
      client.setQueryData(options.queryKey, data);
      setEditing(null);
      setDeleting(null);
      await client.invalidateQueries({ queryKey: ["household-context"] });
      await navigate({
        to: "/members",
        search: {
          member:
            command.operation === "delete" ? data.members[0]?.id : command.id,
        },
        replace: true,
      });
    },
  });
  const members = query.data?.members ?? [];
  const selected =
    members.find((member) => member.id === search.member) ?? members[0];
  function refresh() {
    query.refetch().catch((error: unknown) => {
      console.error("Member refresh failed", error);
    });
  }
  return (
    <>
      <PageHeaderContent slot="details">
        <span className="text-xs text-muted">
          {query.data
            ? `${members.filter((member) => member.kind === "person").length} 人 · ${members.filter((member) => member.kind === "pet").length} 只宠物`
            : ""}
        </span>
      </PageHeaderContent>
      <PageHeaderContent slot="actions">
        <Button
          variant="ghost"
          aria-label="刷新成员资料"
          title="刷新成员资料"
          icon={<RefreshCw size={15} />}
          disabled={!!editing || mutation.isPending}
          status={query.isFetching ? "pending" : "idle"}
          onClick={refresh}
        />
        {!editing ? (
          <Link
            to="/members/new"
            className={`${buttonStyles.base} ${buttonStyles.primary} shrink-0`}
          >
            <Plus size={14} />
            添加成员
          </Link>
        ) : null}
      </PageHeaderContent>
      <div className="mb-6 flex items-center border-b border-line">
        {selected ? (
          <SegmentedControl
            className="min-w-0 flex-1 [&_button]:px-1"
            variant="underline"
            label="家庭成员"
            value={selected.id}
            disabled={!!editing || mutation.isPending}
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
        ) : (
          <span className="flex-1 py-3 text-sm text-muted">家庭成员</span>
        )}
      </div>
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
      {query.isPending ? (
        <Skeleton className="h-64 rounded-2xl" aria-label="正在读取成员" />
      ) : null}
      {query.isSuccess && !selected ? (
        <EmptyState
          icon={<Users size={25} />}
          title="还没有家庭成员"
          description="添加人物或宠物，每位成员都会拥有自己的标签页。"
        />
      ) : null}
      {query.isSuccess && selected ? (
        editing ? (
          <MemberForm
            key={editing.id}
            member={editing}
            pending={mutation.isPending}
            onSave={(id, profile) => {
              mutation.mutate({
                scope_epoch: scope,
                id,
                profile,
                operation: "update",
              });
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
        ) : (
          <MemberOverview
            key={selected.id}
            member={selected}
            scope={scope}
            onEdit={() => {
              mutation.reset();
              setEditing(selected);
            }}
          />
        )
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
                onClick={() => {
                  if (deleting)
                    mutation.mutate({ operation: "delete", id: deleting.id });
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
