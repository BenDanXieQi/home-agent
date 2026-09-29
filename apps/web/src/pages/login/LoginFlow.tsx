import { QrCode, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { AnimatePresence, m } from "motion/react";
import { contentSwap, iconSwap } from "../../utils/motion";
import { useAtomValue, useSetAtom } from "jotai";
import { Button } from "../../components/Button";
import { MijiaVerification } from "./MijiaVerification";
import { RequestFeedback } from "../../components/RequestFeedback";
import { RetryConnectionButton } from "../../modules/mijia/RetryConnectionButton";
import { useLogin } from "../../modules/mijia/use-login";
import {
  mijiaCanStartLoginAutomaticallyAtom,
  startMijiaLoginAutomaticallyAtom,
} from "../../modules/mijia/login";

export function LoginFlow() {
  const flow = useLogin();
  const { login, account, working, busy, canInterrupt, activeLoginId } = flow;

  const shouldStartLogin = useAtomValue(mijiaCanStartLoginAutomaticallyAtom);
  const startAutomatically = useSetAtom(startMijiaLoginAutomaticallyAtom);

  useEffect(() => {
    if (shouldStartLogin)
      startAutomatically().catch((backgroundError: unknown) => {
        console.error("LoginFlow: startAutomatically failed", backgroundError);
      });
  }, [shouldStartLogin, startAutomatically]);
  return (
    <>
      <RequestFeedback
        syncMessage={flow.syncMessage}
        error={flow.error}
        refresh={flow.refresh}
        reconnectLabel="重试连接"
      />
      {!account && flow.syncStatus !== "synced" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={working}
            status={flow.startingLogin ? "pending" : "idle"}
            onClick={flow.startLogin}
          >
            开始登录
          </Button>
          <Button
            variant="ghost"
            disabled={working}
            status={flow.loggingOut ? "pending" : "idle"}
            onClick={flow.logout}
          >
            清除已保存授权
          </Button>
        </div>
      ) : null}
      {flow.cleanupPending ? (
        <div className="my-8">
          <p className="mb-5 mt-5 text-sm leading-7 text-muted">
            当前未登录，摄像头会话清理尚未完成。
          </p>
          <Button
            disabled={working}
            status={flow.loggingOut ? "pending" : "idle"}
            onClick={flow.logout}
          >
            重试清理
          </Button>
        </div>
      ) : null}
      {login?.status === "idle" &&
      (account?.status === "restoring" ||
        account?.status === "restore_error") ? (
        <div className="my-8">
          <p className="mb-5 mt-5 text-sm leading-7 text-muted">
            {account?.status === "restoring"
              ? "正在恢复米家登录…"
              : account?.status === "restore_error" &&
                  account.error.code === "mijia_credential_storage"
                ? "无法读取已保存的授权。修复存储或密钥后重试，也可以清除授权后重新登录。"
                : "暂时无法恢复米家登录，已保存的授权仍会保留。请根据上方提示检查后重试，也可以重新扫码。"}
          </p>
          <div className="flex flex-wrap gap-2">
            <RetryConnectionButton>重试连接</RetryConnectionButton>
            <Button
              disabled={working}
              status={flow.startingLogin ? "pending" : "idle"}
              onClick={flow.startLogin}
            >
              重新扫码
            </Button>
            <Button
              variant="ghost"
              disabled={working}
              status={flow.loggingOut ? "pending" : "idle"}
              onClick={flow.logout}
            >
              清除已保存授权
            </Button>
          </div>
        </div>
      ) : (
        <>
          {login?.status === "security_required" && login.verificationUrl ? (
            <MijiaVerification
              key={login.id}
              verificationUrl={login.verificationUrl}
              disabled={working}
              pending={flow.verifyingLogin}
              onVerify={(ticket) => flow.verifyLogin(login.id, ticket)}
            />
          ) : (
            <>
              <div className="mx-auto grid size-48 place-items-center rounded-xl bg-surface text-muted">
                <AnimatePresence mode="popLayout" initial={false}>
                  {login?.status === "pending" && login.qrImageUrl ? (
                    <m.img
                      className="size-full object-contain p-2"
                      key={login.qrImageUrl}
                      src={login.qrImageUrl}
                      alt="使用米家 App 扫码登录"
                      referrerPolicy="no-referrer"
                      {...iconSwap}
                      initial={{ ...iconSwap.initial, scale: 0.94 }}
                    />
                  ) : (
                    <m.span
                      key="placeholder"
                      className="inline-flex"
                      {...iconSwap}
                    >
                      <QrCode size={72} strokeWidth={1} />
                    </m.span>
                  )}
                </AnimatePresence>
              </div>
              <AnimatePresence mode="popLayout" initial={false}>
                <m.p
                  key={
                    flow.loggingOut
                      ? "logout"
                      : busy
                        ? `busy-${login?.status}`
                        : (login?.status ?? "none")
                  }
                  className="mb-5 mt-5 text-sm leading-7 text-muted"
                  {...contentSwap}
                >
                  {flow.loggingOut
                    ? "正在退出并清理摄像头会话…"
                    : busy
                      ? login?.status === "creating"
                        ? "正在获取二维码…"
                        : "正在完成登录与授权…"
                      : login?.status === "expired"
                        ? "二维码已过期，正在自动刷新…"
                        : login?.status === "pending"
                          ? "打开米家 App 扫码，并在手机上确认。"
                          : login?.status === "idle"
                            ? "正在获取二维码…"
                            : "扫码登录，无需输入账号密码。"}
                </m.p>
              </AnimatePresence>
              <p className="mb-5 mt-5 text-sm leading-7 text-muted">
                扫码登录将授权访问米家昵称、头像和智能家庭服务。
              </p>
            </>
          )}
          {login &&
          (!["idle", "creating", "completing", "completed"].includes(
            login.status,
          ) ||
            (!busy && !!flow.error)) ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={!canInterrupt || !login}
                status={
                  busy && login?.status === "creating" ? "pending" : "idle"
                }
                icon={
                  activeLoginId || login?.status === "expired" ? (
                    <RefreshCw size={13} />
                  ) : undefined
                }
                onClick={flow.startLogin}
              >
                {activeLoginId || login?.status === "expired"
                  ? "刷新二维码"
                  : busy
                    ? "请稍候…"
                    : "重试获取二维码"}
              </Button>
              {activeLoginId ? (
                <Button
                  variant="ghost"
                  disabled={!canInterrupt}
                  status={flow.cancellingLogin ? "pending" : "idle"}
                  onClick={() => flow.cancelLogin(activeLoginId)}
                >
                  {flow.cancellingLogin ? "正在取消…" : "取消登录"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {login?.expiresAt &&
          (login.status === "pending" ||
            (login.status === "security_required" && login.verificationUrl)) ? (
            <p className="mt-3 text-xs text-muted">
              有效期至 {new Date(login.expiresAt).toLocaleTimeString("zh-CN")}
            </p>
          ) : null}
        </>
      )}
    </>
  );
}
