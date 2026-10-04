import { memo, useRef, useState } from "react";
import { MessageSquare, History, X, RefreshCw } from "lucide-react";
import type { useChat } from "../../modules/chat/use-chat";
import { Button } from "../../components/Button";
import { PageHeaderContent } from "../../components/PageHeaderContent";
import { Skeleton } from "../../components/Skeleton";

export const ChatHistory = memo(function ChatHistory({
  threads,
  threadId,
  listLoading,
  historyError,
  nextList,
  loadList,
  onOpen,
}: Pick<
  ReturnType<typeof useChat>,
  | "threads"
  | "threadId"
  | "listLoading"
  | "historyError"
  | "nextList"
  | "loadList"
> & {
  onOpen: (threadId: string) => Promise<void>;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  return (
    <>
      <PageHeaderContent slot="actions">
        <Button
          size="small"
          variant="ghost"
          icon={<History size={15} />}
          ref={toggle}
          aria-expanded={showHistory}
          aria-controls="agent-history"
          onClick={() => setShowHistory((value) => !value)}
        >
          历史会话
        </Button>
      </PageHeaderContent>
      <aside
        id="agent-history"
        hidden={!showHistory}
        className="w-64 shrink-0 flex-col rounded-xl border border-line bg-surface/40 p-3 not-hidden:flex max-md:order-first max-md:max-h-48 max-md:w-full"
        aria-label="历史会话"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="flex-1 text-[13px] font-medium">历史会话</h2>
          <Button
            size="small"
            variant="ghost"
            aria-label="刷新历史会话"
            status={listLoading ? "pending" : "idle"}
            icon={<RefreshCw size={14} />}
            onClick={async () => {
              await loadList();
            }}
          />
          <Button
            size="small"
            variant="ghost"
            aria-label="收起历史会话"
            icon={<X size={15} />}
            onClick={() => {
              setShowHistory(false);
              toggle.current?.focus();
            }}
          />
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {listLoading && !threads.length ? (
            <div className="space-y-2" aria-label="正在读取历史会话">
              {[0, 1, 2].map((item) => (
                <Skeleton key={item} className="h-16 rounded-xl" />
              ))}
            </div>
          ) : null}
          {!threads.length && !listLoading && !historyError ? (
            <div className="px-3 py-8 text-center">
              <MessageSquare
                size={20}
                strokeWidth={1.5}
                className="mx-auto mb-3 text-muted/60"
              />
              <p className="text-xs text-muted">还没有历史会话</p>
              <p className="mt-2 text-[11px] text-muted/70">
                聊过的内容会出现在这里
              </p>
            </div>
          ) : null}
          {!threads.length && !listLoading && historyError ? (
            <p className="px-3 py-5 text-xs leading-5 text-muted">
              暂时无法读取历史会话，请重试。
            </p>
          ) : null}
          {threads.map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              aria-current={threadId === thread.threadId ? "true" : undefined}
              className="group block w-full rounded-xl px-3 py-3 text-left transition-colors hover:bg-surface/70 aria-[current=true]:bg-surface focus-visible:outline-2 focus-visible:outline-accent"
              onClick={async () => {
                await onOpen(thread.threadId);
                setShowHistory(false);
                toggle.current?.focus();
              }}
            >
              <span className="block truncate text-[13px] font-medium">
                {thread.title}
              </span>
              <span className="mt-1 block text-[11px] text-muted">
                {new Date(thread.updatedAt).toLocaleString("zh-CN", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {thread.running ? " · 执行中" : ""}
              </span>
            </button>
          ))}
          {nextList ? (
            <Button
              size="small"
              className="w-full"
              disabled={listLoading}
              onClick={async () => {
                if (nextList) await loadList(nextList);
              }}
            >
              更多会话
            </Button>
          ) : null}
        </div>
      </aside>
    </>
  );
});
