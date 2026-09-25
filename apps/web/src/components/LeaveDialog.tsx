import { AlertDialog } from "radix-ui";
import { AnimatePresence, m } from "motion/react";
import { useRef } from "react";
import { Button } from "./Button";
export function LeaveDialog({
  open,
  onCancel,
  onLeave,
}: {
  open: boolean;
  onCancel: () => void;
  onLeave: () => void;
}) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  return (
    <AlertDialog.Root open={open}>
      <AnimatePresence>
        {open ? (
          <AlertDialog.Portal forceMount>
            <AlertDialog.Overlay asChild forceMount>
              <m.div
                className="fixed inset-0 z-40 bg-ink/25"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              />
            </AlertDialog.Overlay>
            <AlertDialog.Content
              asChild
              forceMount
              onEscapeKeyDown={onCancel}
              onOpenAutoFocus={() => {
                returnFocusRef.current =
                  document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                if (returnFocusRef.current?.isConnected)
                  returnFocusRef.current.focus();
              }}
            >
              <m.div
                className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-paper p-7 shadow-xl"
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
              >
                <AlertDialog.Title className="text-xl font-medium">
                  保留这次修改？
                </AlertDialog.Title>
                <AlertDialog.Description className="mb-7 mt-3 text-sm leading-7 text-muted">
                  配置还没有保存。离开后，本次修改将丢失。
                </AlertDialog.Description>
                <div className="flex justify-end gap-3">
                  <AlertDialog.Cancel asChild>
                    <Button onClick={onCancel}>继续编辑</Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <Button variant="primary" onClick={onLeave}>
                      放弃并离开
                    </Button>
                  </AlertDialog.Action>
                </div>
              </m.div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        ) : null}
      </AnimatePresence>
    </AlertDialog.Root>
  );
}
