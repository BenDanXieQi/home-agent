import { QrCode, RefreshCw } from "lucide-react";
import { Button } from "../../components/Button";
import { MijiaVerification } from "./MijiaVerification";
import { RequestFeedback } from "../../components/RequestFeedback";
import { RetryConnectionButton } from "./RetryConnectionButton";
import { useLogin } from "./use-login";

export function LoginFlow() {
  const flow = useLogin();
  const { login, account, working, busy, canInterrupt, activeLoginId } = flow;
  return (
    <>
      <RequestFeedback
        fetchError={flow.fetchError}
        error={flow.error}
        refresh={flow.refresh}
        retryLabel="重试连接"
        errorClassName="login-error"
      />
      {login?.status === "idle" &&
      (account?.status === "restoring" ||
        account?.status === "restore_error") ? (
        <div className="my-8">
          <p className="login-help">
            {account?.status === "restoring"
              ? "正在恢复米家登录…"
              : account?.status === "restore_error" &&
                  account.error.code === "mijia_credential_storage"
                ? "无法读取已保存的授权。修复存储或密钥后重试，也可以清除授权后重新登录。"
                : "暂时无法恢复米家登录，已保存的授权仍会保留。请根据上方提示检查后重试，也可以重新扫码。"}
          </p>
          <div className="mijia-actions">
            <RetryConnectionButton>重试连接</RetryConnectionButton>
            <Button disabled={working} onClick={flow.startLogin}>
              重新扫码
            </Button>
            <Button variant="ghost" disabled={working} onClick={flow.logout}>
              清除已保存授权
            </Button>
          </div>
        </div>
      ) : (
        <>
          {login?.status === "security_required" ? (
            <MijiaVerification
              key={login.id}
              verificationUrl={login.verificationUrl}
              disabled={working}
              onVerify={(ticket) => flow.verifyLogin(login.id, ticket)}
            />
          ) : (
            <>
              <div className="login-code">
                {login?.status === "pending" ? (
                  <img
                    src={login.qrImageUrl}
                    alt="使用米家 App 扫码登录"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <QrCode size={72} strokeWidth={1} />
                )}
              </div>
              <p className="login-help">
                {busy
                  ? "正在登录…"
                  : login?.status === "expired"
                    ? "二维码已过期，请刷新。"
                    : login?.status === "pending"
                      ? "打开米家 App 扫码，并在手机上确认。"
                      : "扫码登录，无需输入账号密码。"}
              </p>
            </>
          )}
          <div className="mijia-actions">
            <Button
              variant="primary"
              disabled={!canInterrupt || !login}
              onClick={flow.startLogin}
            >
              {activeLoginId || login?.status === "expired" ? (
                <>
                  <RefreshCw size={13} />
                  重新扫码
                </>
              ) : busy ? (
                "请稍候…"
              ) : (
                "获取登录二维码"
              )}
            </Button>
            {activeLoginId ? (
              <Button
                variant="ghost"
                disabled={!canInterrupt}
                onClick={() => flow.cancelLogin(activeLoginId)}
              >
                取消登录
              </Button>
            ) : null}
          </div>
          {login?.status === "pending" ||
          login?.status === "security_required" ? (
            <p className="mt-3 text-xs text-muted">
              有效期至 {new Date(login.expiresAt).toLocaleTimeString("zh-CN")}
            </p>
          ) : null}
        </>
      )}
    </>
  );
}
