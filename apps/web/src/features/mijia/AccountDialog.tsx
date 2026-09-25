import { Dialog } from "radix-ui";
import { X, UserRound } from "lucide-react";
import { Button } from "../../components/Button";
import { LoginFlow } from "./LoginFlow";
import { useLogin } from "./use-login";

export default function AccountDialog() {
  const flow = useLogin();
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
          <span className="account-avatar">
            <UserRound size={20} />
          </span>
          <div>
            <p className="font-medium">
              {flow.fetchError ? "暂时无法确认账号状态" : "已登录"}
            </p>
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
        <LoginFlow />
      </Dialog.Content>
    </Dialog.Portal>
  );
}
