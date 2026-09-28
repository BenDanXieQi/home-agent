import { useRef } from "react";
import { useAtomValue } from "jotai";
import { m } from "motion/react";
import { mijiaAccountAtom } from "../../modules/mijia/account";
import { mijiaAccountLabelAtom } from "../../modules/mijia/login";
import { AccountAvatar } from "../../modules/mijia/AccountAvatar";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "../../components/Button";
import { RequestFeedback } from "../../components/RequestFeedback";
import { useLogin } from "../../modules/mijia/use-login";

/** Rendered inside AnimatePresence, which plays its exit before unmounting. */
export default function AccountDialog() {
  const flow = useLogin();
  const content = useRef<HTMLDivElement>(null);
  const account = useAtomValue(mijiaAccountAtom);
  const accountLabel = useAtomValue(mijiaAccountLabelAtom);
  const name =
    account?.status === "authenticated" ? account.profile?.name : null;
  return (
    <Dialog.Portal forceMount>
      <Dialog.Overlay forceMount asChild>
        <m.div
          className="fixed inset-0 z-40 bg-black/25"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        />
      </Dialog.Overlay>
      <Dialog.Content
        forceMount
        asChild
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
      >
        {/* Background and content are one panel, so they always move together. */}
        <m.div
          ref={content}
          tabIndex={-1}
          className="fixed inset-0 z-50 m-auto h-fit w-[calc(100%-32px)] max-w-[360px] max-h-[calc(100dvh-32px)] overflow-y-auto rounded-3xl bg-white p-7 shadow-xl outline-none"
          initial={{ opacity: 0, scale: 0.96, borderRadius: 24 }}
          animate={{ opacity: 1, scale: 1, borderRadius: 24 }}
          exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.2 } }}
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="m-0 text-base leading-none font-semibold">
              米家账号
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button
                variant="ghost"
                className="relative -top-0.5"
                aria-label="关闭账号窗口"
                icon={<X size={16} />}
              />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-3 text-sm leading-7 text-muted">
            中国大陆 · 授权已加密保存，重启后自动恢复
          </Dialog.Description>
          <div className="my-8 flex items-center gap-3">
            <AccountAvatar />
            <div className="min-w-0">
              {name ? (
                <p className="truncate font-medium" title={name}>
                  {name}
                </p>
              ) : null}
              <p className="text-sm text-muted">{accountLabel}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              style={{ width: "100%" }}
              disabled={flow.working}
              status={flow.loggingOut ? "pending" : "idle"}
              onClick={flow.logout}
            >
              {flow.loggingOut ? "正在退出…" : "退出米家登录"}
            </Button>
          </div>
          <RequestFeedback
            syncMessage={flow.syncMessage}
            error={flow.error}
            refresh={flow.refresh}
          />
        </m.div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
