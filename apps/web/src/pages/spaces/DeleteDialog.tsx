import type { ReactNode } from "react";
import { AlertDialog } from "radix-ui";
import { Button } from "../../components/Button";
import type { Deletion } from "./types";
export function DeleteDialog({
  deleting,
  pending,
  onCancel,
  onDelete,
  feedback,
}: {
  feedback: ReactNode;
  deleting: Deletion | null;
  pending: boolean;
  onCancel: () => void;
  onDelete: (command: Deletion) => void;
}) {
  return (
    <AlertDialog.Root
      open={!!deleting}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-ink/25" />
        <AlertDialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-7 shadow-xl"
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <AlertDialog.Title className="text-xl font-medium">
            删除「{deleting?.label}」？
          </AlertDialog.Title>
          <AlertDialog.Description className="mb-6 mt-3 text-sm leading-7 text-muted">
            删除后无法撤销。有通道或观测绑定引用时，会列出需要先解除的记录。
          </AlertDialog.Description>
          {feedback}
          <div className="flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button disabled={pending}>取消</Button>
            </AlertDialog.Cancel>
            <Button
              variant="primary"
              status={pending ? "pending" : "idle"}
              onClick={() => {
                if (deleting) onDelete(deleting);
              }}
            >
              确认删除
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
