import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertDialog } from "radix-ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import {
  applySpatialLayout,
  type SpatialSnapshot,
} from "../../modules/spatial/api";
import { layoutVersions } from "../../modules/spatial/layout";

/** Clears all spaces and passages so the layout can be planned again. */
export function ResetLayout({
  scope,
  snapshot,
}: {
  scope: string;
  snapshot: SpatialSnapshot;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const reset = useMutation({
    mutationFn: (planned: SpatialSnapshot) =>
      applySpatialLayout(client, scope, {
        expected: layoutVersions(planned),
        spaces: [],
        passages: [],
      }),
    onSuccess: async () => {
      setOpen(false);
      await navigate({ to: "/spaces" });
    },
  });
  if (!snapshot.spaces.length && !snapshot.passages.length) return null;
  const bindings = snapshot.observation_bindings.length;
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (reset.isPending) return;
        reset.reset();
        setOpen(next);
      }}
    >
      <AlertDialog.Trigger asChild>
        <button
          type="button"
          className="rounded-lg px-3 py-2 text-xs text-muted hover:bg-surface hover:text-ink"
        >
          重置空间
        </button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-ink/25" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-7 shadow-xl">
          <AlertDialog.Title className="text-xl font-medium">
            重置空间？
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-3 text-sm leading-7 text-muted">
            {bindings
              ? `还有 ${bindings} 条观测绑定引用这些空间或通道，请先删除这些绑定再重置。`
              : `将删除全部 ${snapshot.spaces.length} 个空间和 ${snapshot.passages.length} 条通道，之后可以用 AI 重新规划。`}
          </AlertDialog.Description>
          {reset.error ? (
            <Notice tone="error" className="mb-0 mt-4">
              {requestErrorMessage(reset.error)}
            </Notice>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button disabled={reset.isPending}>取消</Button>
            </AlertDialog.Cancel>
            {bindings ? null : (
              <Button
                variant="primary"
                status={reset.isPending ? "pending" : "idle"}
                onClick={() => {
                  if (!reset.isPending) reset.mutate(snapshot);
                }}
              >
                重置
              </Button>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
