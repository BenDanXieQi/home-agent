import { useAtomValue } from "jotai";
import { backendStatusAtom } from "./state";
export function BackendStatus() {
  const status = useAtomValue(backendStatusAtom);
  return (
    <output className="flex items-center gap-2 text-xs text-muted">
      <span
        className={`size-1.5 rounded-full ${status === "unavailable" ? "bg-danger" : status === "connected" ? "bg-sage" : "bg-muted"}`}
        aria-hidden="true"
      />
      {status === "unavailable"
        ? "本机服务未连接"
        : status === "connected"
          ? "本机服务已连接"
          : "正在连接本机服务"}
    </output>
  );
}
