import { SearchField } from "../../components/SearchField";
import { memo, useState } from "react";
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import {
  agentReceiptPolicy,
  type agentReceiptIndexSchema,
} from "@home-agent/api/agent-receipts";
import type { z } from "zod";
import { Button } from "../../components/Button";
import { PageHeaderContent } from "../../components/PageHeaderContent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Notice } from "../../components/Notice";
import { useReceiptIndex } from "../../modules/agent-context/receipts";
import { ReceivedContext } from "./ReceivedContext";
import { ReceiptChanges } from "./ReceiptChanges";
import { presentReceiptChange } from "./receipt-presentation";
import { partLabels, time, formatBytes } from "./presentation";

const connectionLabels = {
  stopped: "已停止",
  connecting: "正在连接 Backend",
  connected: "已连接 Backend",
  disconnected: "与 Backend 断开",
};

// Receipt polling must not update the header when its connection state is unchanged.
const ConnectionStatus = memo(function ConnectionStatus({
  connected,
  label,
}: {
  connected: boolean;
  label: string | undefined;
}) {
  return (
    <PageHeaderContent slot="details">
      <span
        aria-hidden={label === undefined ? true : undefined}
        className={`flex items-center gap-2 whitespace-nowrap text-xs text-muted ${label === undefined ? "invisible" : ""}`}
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${connected ? "bg-sage" : "bg-muted"}`}
        />
        {/* Reserve the usual status width until the first read supplies evidence. */}
        {label ?? connectionLabels.connected}
      </span>
    </PageHeaderContent>
  );
});

function ReceiptTimeline({
  data,
}: {
  data: z.infer<typeof agentReceiptIndexSchema>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [reading, setReading] = useState<typeof data | null>(null);
  const query = search.trim().toLocaleLowerCase();
  const rows = (reading ?? data).receipts.filter((receipt) => {
    if (!query) return true;
    const header = `${receipt.sequence} ${receipt.kind === "initial" ? "初始接收" : "状态更新"} ${receipt.parts.map((part) => `${partLabels[part]} ${part}`).join(" ")} ${time(receipt.received_at)}`;
    return (
      header.toLocaleLowerCase().includes(query) ||
      receipt.changes.some((change) => {
        const display = presentReceiptChange(change);
        return `${change.key} ${display.subject} ${display.detail}`
          .toLocaleLowerCase()
          .includes(query);
      })
    );
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted">
          已接收 {data.total_received} 条 · 保留 {data.receipts.length} 条
          {data.evicted ? ` · 已淘汰 ${data.evicted} 条` : ""}
        </span>
        <SearchField
          label="筛选接收记录"
          placeholder="搜索空间、设备、属性或时间"
          value={search}
          onChange={setSearch}
          className="w-full sm:w-72"
        />
      </div>
      {reading ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>阅读中 · 列表暂停刷新</span>
          <Button
            size="small"
            onClick={() => {
              setSelected(null);
              setReading(null);
            }}
          >
            返回最新记录
          </Button>
        </div>
      ) : null}
      <div className="rounded-2xl bg-surface p-2">
        <div className="grid grid-cols-[180px_minmax(0,1fr)_110px_190px_20px] gap-4 px-5 py-3 text-xs text-muted max-md:hidden">
          <span>接收时间</span>
          <span>变化</span>
          <span>接收消息</span>
          <span>上下文</span>
          <span />
        </div>
        <div className="space-y-1">
          {rows.map((receipt) => (
            <div
              key={receipt.id}
              className="overflow-hidden rounded-xl bg-white"
            >
              <button
                type="button"
                aria-expanded={selected === receipt.id}
                onClick={() => {
                  const closing = selected === receipt.id;
                  setSelected(closing ? null : receipt.id);
                  setReading(closing ? null : (reading ?? data));
                }}
                className="grid min-h-18 w-full grid-cols-[180px_minmax(0,1fr)_110px_190px_20px] items-center gap-x-4 gap-y-2 px-5 py-4 text-left hover:bg-surface/50 focus-visible:outline-2 focus-visible:-outline-offset-2 max-md:grid-cols-[minmax(0,1fr)_20px]"
              >
                <span className="text-xs tabular-nums">
                  <span className="block">{time(receipt.received_at)}</span>
                  <span className="mt-1 block text-muted">
                    #{receipt.sequence}
                    {receipt.kind === "initial" ? " · 初始接收" : ""}
                  </span>
                </span>
                <span className="min-w-0 max-md:col-start-1 max-md:row-start-2">
                  <span className="block text-[13px]">
                    {receipt.changes.length ? (
                      receipt.changes
                        .slice(0, 3)
                        .map(presentReceiptChange)
                        .map((change, index) => (
                          <span
                            key={index}
                            className="mb-1 grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-x-3 gap-y-1 last:mb-0 max-sm:grid-cols-1"
                          >
                            <span
                              className="truncate font-medium"
                              title={change.subject}
                            >
                              {change.subject}
                            </span>
                            <span
                              className="line-clamp-2 break-words text-muted"
                              title={change.detail}
                            >
                              {change.detail}
                            </span>
                          </span>
                        ))
                    ) : (
                      <span className="text-muted">无属性或观察变化</span>
                    )}
                  </span>
                  <span className="mt-1 block text-xs text-muted">
                    {receipt.parts.map((name) => partLabels[name]).join("、") ||
                      "家庭资格更新"}
                    {receipt.changes.length > 3
                      ? ` · 另 ${receipt.changes.length - 3} 项变化`
                      : ""}
                  </span>
                  {!receipt.synchronized ? (
                    <span className="mt-1 block text-xs text-muted">
                      等待初始数据
                    </span>
                  ) : null}
                </span>
                <span
                  title={`${receipt.payload_bytes.toLocaleString()} 字节`}
                  className="text-xs tabular-nums text-muted max-md:col-start-1 max-md:row-start-3"
                >
                  <span className="md:hidden">接收消息：</span>
                  {formatBytes(receipt.payload_bytes)}
                </span>
                <span
                  title={`${receipt.context_bytes.toLocaleString()} 字节`}
                  className="text-xs tabular-nums text-muted max-md:col-start-1 max-md:row-start-4"
                >
                  <span className="md:hidden">上下文：</span>
                  {formatBytes(receipt.context_bytes)}
                  {receipt.kind !== "initial" &&
                  receipt.context_delta_bytes !== 0 ? (
                    <span className="ml-2" title="较上一条记录的大小变化">
                      {receipt.context_delta_bytes > 0 ? "+" : ""}
                      {receipt.context_delta_bytes.toLocaleString()} B
                    </span>
                  ) : null}
                </span>
                {selected === receipt.id ? (
                  <ChevronDown
                    size={14}
                    className="text-muted max-md:col-start-2 max-md:row-start-1"
                  />
                ) : (
                  <ChevronRight
                    size={14}
                    className="text-muted max-md:col-start-2 max-md:row-start-1"
                  />
                )}
              </button>
              {selected === receipt.id ? (
                <div className="border-t border-line/60 px-5 py-4">
                  <ReceiptChanges key={receipt.id} changes={receipt.changes} />
                </div>
              ) : null}
            </div>
          ))}
          {!rows.length ? (
            <div className="flex flex-col items-center gap-3 rounded-xl bg-white px-5 py-12 text-center text-sm text-muted">
              <ArrowDownToLine size={24} strokeWidth={1.5} />
              <p>
                {search ? "没有匹配的接收记录" : "Agent 尚未接收到数据消息"}
              </p>
              <p className="text-xs">
                {search
                  ? "试试其他时间或数据部分名称。"
                  : "收到并通过校验的消息会出现在这里，心跳不计入数据消息。"}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function AgentContextPage() {
  const query = useReceiptIndex();
  const [tab, setTab] = useState<"receipts" | "context" | "compressed">(
    "receipts",
  );
  // A failed read must not present the last successful response as current receipt evidence.
  const data = query.isError ? undefined : query.data;
  return (
    <section className="space-y-4 [overflow-anchor:none]">
      <ConnectionStatus
        connected={data?.connection.status === "connected"}
        label={
          data
            ? `${connectionLabels[data.connection.status]}${data.connection.synchronized ? "" : " · 等待初始数据"}`
            : query.isError
              ? "Agent 不可用"
              : undefined
        }
      />
      <PageHeaderContent slot="actions">
        {tab === "receipts" ? (
          <Button
            variant="ghost"
            icon={<RefreshCw size={14} />}
            status={query.isFetching ? "pending" : "idle"}
            onClick={() => {
              query.refetch().catch(() => {
                console.warn("Agent receipt refresh failed");
              });
            }}
          >
            刷新接收记录
          </Button>
        ) : null}
      </PageHeaderContent>
      <SegmentedControl
        label="Agent 数据观察"
        variant="underline"
        className="border-b border-line"
        value={tab}
        onValueChange={setTab}
        options={[
          { value: "receipts", label: "接收记录" },
          { value: "context", label: "原始上下文" },
          { value: "compressed", label: "压缩后上下文" },
        ]}
      />

      {query.isError ? (
        <Notice tone="error">
          无法读取 Agent 接收端。请确认 Agent 服务已启动且服务地址正确。
        </Notice>
      ) : !data ? (
        <output className="py-10 text-sm text-muted">
          正在读取 Agent 接收记录…
        </output>
      ) : (
        <>
          {data.connection.last_error ? (
            <Notice tone="warning">
              接收连接异常：{data.connection.last_error.reason} ·{" "}
              {time(data.connection.last_error.at)}
            </Notice>
          ) : null}
          {tab === "receipts" ? (
            <ReceiptTimeline key={data.journal_id} data={data} />
          ) : (
            <ReceivedContext
              key={data.journal_id}
              journalId={data.journal_id}
              compressed={tab === "compressed"}
            />
          )}
          <details className="border-t border-line pt-3 text-xs text-muted">
            <summary className="w-fit cursor-pointer py-1 focus-visible:outline-2">
              说明与连接详情
            </summary>
            <div className="mt-3 space-y-2 leading-6">
              <p>
                每 2 秒读取 Agent 接收记录，心跳不计入记录。展开时暂停列表刷新，
                Agent
                继续接收；原始上下文和压缩后上下文通过“获取最新上下文”更新。
                列表预览前三项变化，展开查看全部；搜索匹配全部变化中的空间、观测来源与目标、房间、设备、属性和变化值。
              </p>
              <p>
                消息只包含本次提供的部分，省略部分沿用旧值；设备增量仅更新或删除指定条目，
                其他部分整体替换。展开详情只展示该次接收的完整变化。
              </p>
              <p>
                消息大小按 SSE 正文计算，上下文按 scope 与 parts 的紧凑 JSON
                计算， 均为 UTF-8
                字节数；精确大小可悬停查看，增减相对上一条记录。
                大小不变不表示内容未变。
              </p>
              <p>
                最多保留 {agentReceiptPolicy.records} 条，内存预算{" "}
                {agentReceiptPolicy.retainedBytes / 1024 / 1024}{" "}
                MiB，超限淘汰最早记录。 重连、切换家庭或 Agent
                重启会清空，不代表完整历史。
              </p>
              <p>
                最近数据：{time(data.received_at)} · 最近心跳：
                {time(data.heartbeat_at)}
              </p>
              <p className="break-all">
                家庭：{data.scope?.home_id ?? "无可用家庭"} · 接收会话：
                {data.journal_id}
              </p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
