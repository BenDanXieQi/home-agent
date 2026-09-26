import { useAtomValue } from "jotai";
import { mijiaAccountAtom, mijiaAccountLabelAtom } from "./state";
import { AccountAvatar } from "./AccountAvatar";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "../../components/Button";
import { RequestFeedback } from "../../components/RequestFeedback";
import { useLogin } from "./use-login";

export default function AccountDialog() {
  const flow = useLogin();
  const account = useAtomValue(mijiaAccountAtom);
  const accountLabel = useAtomValue(mijiaAccountLabelAtom);
  const name =
    account?.status === "authenticated" ? account.profile?.name : null;
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="login-dialog">
        <div className="flex items-center justify-between">
          <Dialog.Title className="text-base font-semibold">
            米家账号
          </Dialog.Title>
          <Dialog.Close asChild>
            <Button variant="ghost" aria-label="关闭账号窗口">
              <X size={16} />
            </Button>
          </Dialog.Close>
        </div>
        <Dialog.Description className="mt-2 text-xs text-muted">
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
            <p className="text-xs text-muted">{accountLabel}</p>
            {flow.deviceCount !== null ? (
              <p className="mt-1 text-xs text-muted">
                {flow.deviceCount} 台设备
              </p>
            ) : null}
          </div>
        </div>
        <div className="mijia-actions">
          <Button disabled={flow.working} onClick={flow.logout}>
            退出米家登录
          </Button>
        </div>
        <RequestFeedback
          fetchError={flow.fetchError}
          error={flow.error}
          refresh={flow.refresh}
        />
      </Dialog.Content>
    </Dialog.Portal>
  );
}
