import { JsonExport } from "../../components/json/JsonExport";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { SegmentedControl } from "../../components/SegmentedControl";
import {
  useReceipt,
  useReceivedContext,
} from "../../modules/agent-context/receipts";
import { JsonData } from "../../components/json/JsonData";
import { ReceiptChanges } from "./ReceiptChanges";
import { ContextBrowser } from "./ContextBrowser";
import { partLabels, time, formatBytes } from "./presentation";

export function ReceiptDetail({
  journalId,
  id,
}: {
  journalId: string;
  id: string;
}) {
  const query = useReceipt(journalId, id);
  const [view, setView] = useState<"message" | "context">("message");
  const receipt = query.data;
  if (query.isError)
    return (
      <Notice tone="warning">
        这条接收记录已被淘汰、会话已变化或 Agent 暂时不可用，请刷新接收列表。
      </Notice>
    );
  if (!receipt)
    return (
      <output className="py-6 text-xs text-muted">
        正在从 Agent 读取这条接收记录…
      </output>
    );
  const value = view === "message" ? receipt.message : receipt.context;
  const truncatedParts = receipt.parts.filter(
    (name) => receipt.message.data.parts[name]?.truncated,
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label="接收记录内容"
          variant="underline"
          value={view}
          onValueChange={setView}
          options={[
            { value: "message", label: "接收消息" },
            { value: "context", label: "合并后上下文" },
          ]}
        />
        <JsonExport
          source={{ kind: "value", value: receipt }}
          name={`agent-receipt-${receipt.sequence}`}
          label="导出记录 JSON"
        />
      </div>
      {truncatedParts.length ? (
        <Notice tone="warning">
          {truncatedParts.map((name) => partLabels[name]).join("、")}
          ：来源已截断
        </Notice>
      ) : null}
      <ReceiptChanges key={receipt.id} changes={receipt.changes} />
      <ContextBrowser
        key={view}
        message={view === "message"}
        snapshot={view === "message" ? receipt.message.data : receipt.context}
      />
      <JsonData
        key={`raw-${view}`}
        value={value}
        label={view === "message" ? "接收消息 JSON" : "合并后上下文 JSON"}
      />
    </div>
  );
}

export function ReceivedContext({ journalId }: { journalId: string }) {
  const query = useReceivedContext(journalId);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1 text-xs text-muted">
          <p className="font-medium text-ink">当前上下文快照</p>
          {query.data ? (
            <p title={`${query.data.context_bytes.toLocaleString()} 字节`}>
              {formatBytes(query.data.context_bytes)} · 最后接收：
              {time(query.data.received_at)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {query.data && !query.isError ? (
            <JsonExport
              source={{ kind: "value", value: query.data }}
              name="agent-current-context"
            />
          ) : null}
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
            重新读取
          </Button>
        </div>
      </div>
      {query.isError ? (
        <Notice tone="error">无法读取 Agent 当前上下文，请重新读取。</Notice>
      ) : query.data ? (
        <>
          <ContextBrowser
            key={query.data.received_at ?? "empty"}
            snapshot={query.data}
          />
          <JsonData
            value={query.data}
            label="完整上下文 JSON · 复制与原始字段"
          />
        </>
      ) : (
        <output className="text-xs text-muted">正在读取…</output>
      )}
    </div>
  );
}
