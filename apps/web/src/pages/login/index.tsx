import { House } from "lucide-react";
import { LoginFlow } from "./LoginFlow";

export default function LoginPage() {
  return (
    <main className="min-h-dvh bg-paper">
      <header className="flex h-20 items-center gap-2.5 px-8 text-sm font-semibold">
        <House size={22} strokeWidth={1.6} />
        <span>Home Agent</span>
      </header>
      <section
        className="mx-auto mt-[6vh] w-[calc(100%-32px)] max-w-[400px] rounded-3xl bg-white px-8 py-10 shadow-panel text-center [&_h1]:text-xl [&_h1]:font-semibold"
        aria-labelledby="login-title"
      >
        <h1 id="login-title">登录米家</h1>
        <p className="mb-8 mt-3 text-sm leading-7 text-muted">
          使用米家账号连接你的设备与摄像头。
        </p>
        <LoginFlow />
        <div className="mt-8 text-xs leading-6 text-muted">
          中国大陆 · 授权加密保存在本机，重启后自动恢复
        </div>
      </section>
    </main>
  );
}
