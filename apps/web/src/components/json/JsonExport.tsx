import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "../Button";
import type { exportJson } from "./json-export.worker";

export function JsonExport({
  source,
  name,
  label = "下载 JSON 文件",
}: {
  source:
    | { kind: "value"; value: unknown }
    | { kind: "formatted"; json: string };
  name: string;
  label?: string;
}) {
  const [status, setStatus] = useState<"idle" | "pending" | "failed">("idle");
  const active = useRef<Worker | null>(null);
  useEffect(
    () => () => {
      active.current?.terminate();
      active.current = null;
    },
    [],
  );
  function save(blob: Blob) {
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name}.json`;
      link.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  function download() {
    if (active.current) return;
    setStatus("pending");
    try {
      if (source.kind === "formatted") {
        save(new Blob([source.json], { type: "application/json" }));
        setStatus("idle");
        return;
      }
      const worker = new Worker(
        new URL("./json-export.worker.ts", import.meta.url),
        { type: "module" },
      );
      active.current = worker;
      function finish(failed: boolean) {
        if (active.current !== worker) return;
        worker.terminate();
        active.current = null;
        setStatus(failed ? "failed" : "idle");
      }
      worker.addEventListener(
        "message",
        (event: MessageEvent<ReturnType<typeof exportJson>>) => {
          if (active.current !== worker) return;
          if (event.data.kind === "failed") {
            finish(true);
            return;
          }
          try {
            save(event.data.blob);
            finish(false);
          } catch {
            finish(true);
          }
        },
        { once: true },
      );
      worker.addEventListener("error", () => finish(true), { once: true });
      worker.addEventListener("messageerror", () => finish(true), {
        once: true,
      });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated worker messaging has no targetOrigin.
      worker.postMessage(source.value);
    } catch {
      active.current?.terminate();
      active.current = null;
      setStatus("failed");
    }
  }
  return (
    <div className="flex items-center gap-2">
      <Button
        size="small"
        icon={<Download size={14} />}
        status={status === "pending" ? "pending" : "idle"}
        onClick={download}
      >
        {label}
      </Button>
      {status === "failed" ? (
        <span role="alert" className="text-xs text-danger">
          导出失败，请重试
        </span>
      ) : null}
    </div>
  );
}
