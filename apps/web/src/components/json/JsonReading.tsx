import type { PropsWithChildren, ReactNode } from "react";
import { Copy, Download } from "lucide-react";
import { Button } from "../Button";
import { JsonExport } from "./JsonExport";

export function JsonToolbar({
  status,
  children,
}: PropsWithChildren<{ status: ReactNode }>) {
  return (
    <div className="flex flex-col items-start justify-between gap-2 text-xs text-muted sm:flex-row sm:items-center">
      <output>{status}</output>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Match the reader's toolbar and viewport while conversion or code loading runs. */
export function JsonLoading({
  value,
  name,
  message,
  awaitingValue = false,
}: {
  value: unknown;
  name: string;
  message: string;
  awaitingValue?: boolean;
}) {
  return (
    <div className="space-y-2">
      <JsonToolbar status={<span aria-live="polite">{message}</span>}>
        {awaitingValue ? (
          <Button size="small" icon={<Download size={14} />} disabled>
            下载 JSON 文件
          </Button>
        ) : (
          <JsonExport source={{ kind: "value", value }} name={name} />
        )}
        <Button size="small" icon={<Copy size={14} />} disabled>
          复制 JSON 内容
        </Button>
      </JsonToolbar>
      <div className="h-96 rounded-xl bg-surface" aria-hidden="true" />
    </div>
  );
}
