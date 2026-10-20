import { useEffect, useState, type ReactNode } from "react";
import type { z } from "zod";
import type { conversationProgressSchema } from "@home-agent/agent/conversation/contracts";
import { LoaderCircle } from "lucide-react";
import { Button } from "../Button";
import { MarkdownAnswer } from "./MarkdownAnswer";

export function StreamingAnswer({
  progress,
  startedAt,
  onStop,
  pendingLabel = "正在分析",
  stopLabel = "停止",
  toolLabels,
  children,
}: {
  progress: z.infer<typeof conversationProgressSchema> | null;
  startedAt: number;
  onStop: () => void;
  pendingLabel?: string;
  stopLabel?: string;
  toolLabels?: Readonly<Record<string, string>>;
  children?: ReactNode;
}) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="grid gap-3">
      {progress?.reply ? (
        <MarkdownAnswer>{progress.reply}</MarkdownAnswer>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 text-sm">
        <div className="grid gap-1.5">
          <output className="flex items-center gap-1.5 text-ink">
            <LoaderCircle
              size={14}
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {progress?.tools.some((tool) => tool.status === "running")
              ? "正在执行工具"
              : progress?.reply
                ? "正在生成回答"
                : pendingLabel}
          </output>
          {children}
          {progress?.tools.length ? (
            <div className="text-xs text-muted" aria-live="polite">
              {progress.tools.map((tool) => (
                <p key={tool.callId}>
                  {toolLabels?.[tool.name] ?? tool.name}
                  {tool.status === "done"
                    ? " · 已完成"
                    : tool.status === "running"
                      ? " · 进行中"
                      : " · 等待中"}
                </p>
              ))}
            </div>
          ) : null}
          <span className="text-xs text-muted">已用时 {seconds} 秒</span>
        </div>
        <Button size="small" onClick={onStop}>
          {stopLabel}
        </Button>
      </div>
    </div>
  );
}
