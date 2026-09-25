import { House } from "lucide-react";
import { LoginFlow } from "../features/mijia/LoginFlow";

export default function LoginPage() {
  return (
    <main className="login-screen">
      <header>
        <House size={22} strokeWidth={1.6} />
        <span>Home Agent</span>
      </header>
      <section className="login-panel" aria-labelledby="login-title">
        <h1 id="login-title">登录米家</h1>
        <p className="login-subtitle">使用米家账号连接你的设备与摄像头。</p>
        <LoginFlow />
        <div className="login-note">
          中国大陆 · 授权加密保存在本机，重启后自动恢复
        </div>
      </section>
    </main>
  );
}
