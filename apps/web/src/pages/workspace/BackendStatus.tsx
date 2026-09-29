import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { backendStatusAtom } from "../../modules/connections/state";

export function BackendStatus({
  children,
}: {
  children: (indicator: ReactNode, hint?: string) => ReactNode;
}) {
  const status = useAtomValue(backendStatusAtom);
  if (status !== "unavailable") return children(null);
  const label = "本机服务未连接，点击设置检查连接";
  const dot = (
    <span
      className="size-1.5 shrink-0 rounded-full bg-danger"
      aria-hidden="true"
    />
  );
  return children(dot, label);
}
