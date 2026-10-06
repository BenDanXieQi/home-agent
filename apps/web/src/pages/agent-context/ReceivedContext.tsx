import { RefreshCw } from "lucide-react";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { useModelContext } from "../../modules/agent-context/use-model-context";
import { useReceivedContext } from "../../modules/agent-context/receipts";
import { JsonData } from "../../components/json/JsonData";
import { ContextBrowser } from "./ContextBrowser";
import { time, formatBytes } from "./presentation";

export function ReceivedContext({
  journalId,
  compressed = false,
}: {
  journalId: string;
  compressed?: boolean;
}) {
  const query = useReceivedContext(journalId);
  const modelContext = useModelContext(
    query.isError ? undefined : query.data,
    compressed,
    query.dataUpdatedAt,
  );
  const bytes = compressed
    ? modelContext?.status === "ready"
      ? modelContext.bytes
      : undefined
    : query.data?.context_bytes;
  const name = compressed
    ? "agent-compressed-context"
    : "agent-original-context";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-h-9 space-y-1 text-xs text-muted">
          <p className="font-medium text-ink">
            {compressed ? "压缩后上下文" : "原始上下文快照"}
          </p>
          {query.data && !query.isError && bytes !== undefined ? (
            <p title={`${bytes.toLocaleString()} 字节`}>
              {formatBytes(bytes)} · 最后接收：
              {time(query.data.received_at)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="small"
            icon={<RefreshCw size={14} />}
            status={query.isFetching ? "pending" : "idle"}
            onClick={() => {
              query.refetch().catch(() => {
                console.warn("Agent context refresh failed");
              });
            }}
          >
            获取最新上下文
          </Button>
        </div>
      </div>
      {query.isError ? (
        <Notice tone="error">
          无法读取 Agent 原始上下文，请获取最新上下文。
        </Notice>
      ) : compressed && modelContext?.status === "failed" ? (
        <Notice
          tone={
            modelContext.reason === "conversion_failed" ? "error" : "warning"
          }
        >
          {modelContext.reason === "not_ready"
            ? "家庭范围或上下文数据尚未就绪，请等待数据接收后获取最新上下文。"
            : modelContext.reason === "invalid_identity"
              ? "上下文中的设备或属性标识不一致，请检查来源数据后获取最新上下文。"
              : "上下文转换失败，请查看错误详情。"}
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer">错误详情</summary>
            <p className="mt-2 break-words">{modelContext.message}</p>
          </details>
        </Notice>
      ) : compressed ? (
        <>
          <p className="text-xs leading-6 text-muted">
            展示设备最新属性、成员资料与最后出现，以及各摄像头的最新线索。最后出现可能早于
            30 分钟，不代表当前位置。
          </p>
          <JsonData
            key={name}
            value={
              modelContext?.status === "ready" ? modelContext.value : undefined
            }
            label="查看压缩后上下文 JSON"
            name={name}
            defaultOpen
            loadingMessage={
              modelContext?.status === "ready"
                ? undefined
                : query.data
                  ? "正在生成压缩后上下文…"
                  : "正在读取…"
            }
          />
        </>
      ) : query.data ? (
        <>
          <ContextBrowser
            key={query.data.received_at ?? "empty"}
            snapshot={query.data}
          />
          <JsonData
            key={name}
            value={query.data}
            label="查看完整原始上下文 JSON"
            name={name}
          />
        </>
      ) : (
        <output className="text-xs text-muted">正在读取…</output>
      )}
    </div>
  );
}
