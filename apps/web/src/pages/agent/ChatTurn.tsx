import { memo } from "react";
import type { chatTurnSchema } from "@home-agent/api/contracts";
import { Wrench } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Notice } from "../../components/Notice";
import { MarkdownAnswer } from "./MarkdownAnswer";

const toolLabels = {
  get_household_overview: "查询家庭概览",
  query_devices: "查找设备",
  get_device_state: "读取设备状态",
  query_members: "查询成员资料",
};
export const ChatTurn = memo(function ChatTurn({
  turn,
}: {
  turn: ReturnType<typeof chatTurnSchema.parse>;
}) {
  return (
    <article className="space-y-4">
      <div className="ml-auto max-w-[85%] w-fit whitespace-pre-wrap break-words rounded-xl bg-surface px-5 py-3 text-sm leading-7">
        <span className="sr-only">你：</span>
        {turn.message}
      </div>
      <div className="flex items-start gap-3">
        <AgentAvatar
          state={turn.status === "running" ? "thinking" : "idle"}
          className="size-8 text-ink"
        />
        <div className="min-w-0 flex-1 space-y-3">
          {turn.tools.map((tool) => {
            const finished = tool.output !== null;
            return (
              <details
                key={tool.callId}
                className="group rounded-lg border border-line bg-surface/50 px-3 py-2 text-xs"
              >
                <summary className="cursor-pointer py-1 text-muted marker:text-muted/40">
                  <Wrench size={13} className="mr-2 inline" />
                  {toolLabels[tool.name]}
                  <span
                    className={`ml-3 text-[11px] ${finished ? "text-sage" : "text-muted"}`}
                  >
                    {finished
                      ? "已返回"
                      : turn.status === "running"
                        ? "调用中…"
                        : "未完成"}
                  </span>
                </summary>
                <div className="space-y-3 pt-3">
                  <p className="font-mono text-muted">{tool.name}</p>
                  <div>
                    <p className="mb-1 font-medium">参数</p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-3">
                      {JSON.stringify(tool.input, null, 2)}
                    </pre>
                  </div>
                  {finished ? (
                    <div>
                      <p className="mb-1 font-medium">
                        返回结果
                        {tool.truncated ? "（内容已截短）" : ""}
                      </p>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-3">
                        {tool.output}
                      </pre>
                    </div>
                  ) : null}
                </div>
              </details>
            );
          })}
          {turn.answer ? <MarkdownAnswer>{turn.answer}</MarkdownAnswer> : null}
          {turn.status === "running" ? (
            <output className="flex min-h-8 items-center text-xs leading-5 text-muted">
              正在处理…
            </output>
          ) : null}
          {turn.status === "incomplete" ? (
            <p className="flex min-h-8 items-center text-xs leading-5 text-muted">
              执行未完成 · 已保存的内容
            </p>
          ) : null}
          {turn.error ? (
            <Notice
              tone={turn.status === "cancelled" ? "neutral" : "error"}
              className="mb-0"
            >
              {turn.error} 可新建对话重新尝试，不会自动重发。
            </Notice>
          ) : null}
          {turn.runId ? (
            <details className="text-[11px] text-muted/60">
              <summary className="cursor-pointer">
                执行信息 ·{" "}
                {turn.status === "completed"
                  ? "已完成"
                  : turn.status === "running"
                    ? "进行中"
                    : "未完成"}
              </summary>
              <p className="mt-2 break-all font-mono">runId: {turn.runId}</p>
            </details>
          ) : null}
        </div>
      </div>
    </article>
  );
});
