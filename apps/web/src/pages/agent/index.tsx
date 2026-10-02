import { useEffect, useRef, useState } from "react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Skeleton } from "../../components/Skeleton";
import { MarkdownAnswer } from "./MarkdownAnswer";
import { useAtomValue } from "jotai";
import {
  ArrowUp,
  House,
  Users,
  LampDesk,
  ArrowUpRight,
  MessageSquare,
  Plus,
  Square,
  Wrench,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
} from "lucide-react";
import { householdScopeEpochAtom } from "../../modules/household/state";
import { useChat } from "../../modules/chat/use-chat";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { PageHeaderContent } from "../../components/PageHeaderContent";

const prompts = [
  { icon: House, title: "了解家里的情况", message: "家里有哪些房间和设备？" },
  { icon: LampDesk, title: "查看房间设备", message: "客厅有哪些设备？" },
  { icon: Users, title: "认识家庭成员", message: "家里登记了哪些人物和宠物？" },
];
const toolLabels = {
  get_household_overview: "查询家庭概览",
  query_devices: "查找设备",
  get_device_state: "读取设备状态",
  query_members: "查询成员资料",
};
function ChatWorkspace({ scope }: { scope: string | undefined }) {
  const chat = useChat(scope);
  const [showHistory, setShowHistory] = useState(true);
  const [draft, setDraft] = useState("");
  const [validation, setValidation] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (chat.turns.at(-1) && follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [chat.turns]);
  async function submit(message = draft) {
    if (
      chat.busy ||
      chat.historyLoading ||
      !chat.canContinue ||
      !message.trim()
    )
      return;
    if (
      new TextEncoder().encode(
        JSON.stringify({ message: message.trim(), threadId: chat.threadId }),
      ).length > 32_768
    ) {
      setValidation("消息过长，请缩短后再发送。");
      return;
    }
    setValidation("");
    setDraft("");
    follow.current = true;
    await chat.send(message);
    input.current?.focus();
  }
  return (
    <div className="flex h-full min-h-0 gap-6 max-md:flex-col max-md:gap-3">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <PageHeaderContent slot="details">
          <span className="text-xs text-muted">你的家庭助手</span>
        </PageHeaderContent>
        <PageHeaderContent slot="actions">
          <Button
            size="small"
            icon={<Plus size={15} />}
            onClick={() => {
              chat.reset();
              setDraft("");
              setValidation("");
              input.current?.focus();
            }}
          >
            新对话
          </Button>
        </PageHeaderContent>
        {chat.historyError ? (
          <Notice tone="error" className="mb-0">
            {chat.historyError}
            {chat.threadId ? (
              <Button
                size="small"
                onClick={async () => {
                  if (chat.threadId) await chat.openHistory(chat.threadId);
                }}
              >
                重新加载会话
              </Button>
            ) : null}
          </Notice>
        ) : null}
        {chat.historyLoading ? (
          <output className="text-xs text-muted">正在读取历史消息…</output>
        ) : null}
        {!chat.canContinue &&
        !chat.busy &&
        !chat.historyLoading &&
        !chat.historyError ? (
          <Notice className="mb-0">
            {chat.historyRunning
              ? "这个会话仍在执行，稍后重新加载查看。"
              : "这个会话没有完整结束，历史内容仅供查看。可新建对话继续提问。"}
            {chat.threadId ? (
              <Button
                size="small"
                onClick={async () => {
                  if (chat.threadId) await chat.openHistory(chat.threadId);
                }}
              >
                重新加载
              </Button>
            ) : null}
          </Notice>
        ) : null}
        <div
          ref={scroller}
          onScroll={() => {
            const el = scroller.current;
            if (el)
              follow.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 max-md:px-0"
          aria-label="对话记录"
        >
          {chat.hasEarlier ? (
            <Button
              size="small"
              className="mb-4"
              disabled={chat.historyLoading || chat.busy}
              onClick={async () => {
                follow.current = false;
                await chat.loadEarlier();
              }}
            >
              加载更早的消息
            </Button>
          ) : null}
          {chat.turns.length === 0 && !chat.historyLoading && !chat.threadId ? (
            <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center py-10 max-md:py-5">
              <AgentAvatar className="mb-6 size-16 text-sage" />
              <h2 className="text-2xl font-medium tracking-tight max-md:text-xl">
                今天，想了解家里的什么？
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted">
                从房间设备到家庭成员，随时问我。
              </p>
              <div className="mt-8 grid w-full grid-cols-3 gap-3 max-md:mt-6 max-md:grid-cols-1">
                {prompts.map(({ icon: Icon, title, message }) => (
                  <button
                    key={message}
                    type="button"
                    className="group rounded-2xl bg-surface p-4 text-left transition-colors hover:bg-sage/10 focus-visible:outline-2 focus-visible:outline-sage max-md:flex max-md:items-center max-md:gap-3 max-md:py-3"
                    onClick={() => {
                      setDraft(message);
                      input.current?.focus();
                    }}
                  >
                    <Icon
                      size={19}
                      strokeWidth={1.5}
                      className="shrink-0 text-sage"
                    />
                    <div className="min-w-0 flex-1">
                      <span className="mt-4 block text-[13px] font-medium max-md:mt-0">
                        {title}
                      </span>
                      <span className="mt-2 block text-xs leading-5 text-muted max-md:mt-0.5">
                        {message}
                      </span>
                    </div>
                    <ArrowUpRight
                      size={14}
                      className="mt-4 text-muted/60 transition-colors group-hover:text-sage max-md:mt-0"
                    />
                  </button>
                ))}
              </div>
              <p className="mt-5 text-center text-[11px] leading-5 text-muted/80">
                支持信息查询，暂不支持设备控制和人物、宠物定位
              </p>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-10 py-6">
              {chat.turns.map((turn) => (
                <article key={turn.id} className="space-y-4">
                  <div className="ml-auto max-w-[85%] w-fit whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-surface px-5 py-3 text-sm leading-7">
                    <span className="sr-only">你：</span>
                    {turn.message}
                  </div>
                  <div className="flex gap-3">
                    <AgentAvatar
                      state={turn.status === "running" ? "thinking" : "idle"}
                      className="size-8 text-sage"
                    />
                    <div className="min-w-0 flex-1 space-y-3">
                      {turn.tools.map((tool) => {
                        const finished = tool.output !== null;
                        return (
                          <details
                            key={tool.callId}
                            className="group rounded-xl bg-surface/60 px-3 py-2 text-xs"
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
                              <p className="font-mono text-muted">
                                {tool.name}
                              </p>
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
                      {turn.answer ? (
                        <MarkdownAnswer>{turn.answer}</MarkdownAnswer>
                      ) : null}
                      {turn.status === "running" ? (
                        <output className="block text-xs text-muted">
                          正在处理…
                        </output>
                      ) : null}
                      {turn.status === "incomplete" ? (
                        <p className="text-xs text-warning">
                          这一轮执行未完成，显示已保存的内容。
                        </p>
                      ) : null}
                      {turn.error ? (
                        <Notice
                          tone={
                            turn.status === "cancelled" ? "neutral" : "error"
                          }
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
                          <p className="mt-2 break-all font-mono">
                            runId: {turn.runId}
                          </p>
                        </details>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
        <form
          className="mx-auto w-full max-w-3xl shrink-0 rounded-2xl border border-line bg-surface/50 p-3 transition-colors focus-within:border-sage/40 focus-within:bg-white"
          onSubmit={(event) => {
            event.preventDefault();
            submit().catch(() => {
              setValidation("发送失败，请检查消息后重试。");
            });
          }}
        >
          <label htmlFor="agent-message" className="sr-only">
            发送给 Agent 的消息
          </label>
          <textarea
            id="agent-message"
            ref={input}
            value={draft}
            maxLength={16_000}
            disabled={chat.historyLoading || !chat.canContinue}
            rows={2}
            placeholder="问问家里的情况…"
            className="w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none rounded-lg"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {validation ? (
            <p role="alert" className="px-2 text-xs text-danger">
              {validation}
            </p>
          ) : null}
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="pl-2 text-xs text-muted">
              Enter 发送 · Shift + Enter 换行
            </p>
            {chat.busy ? (
              <Button
                type="button"
                size="small"
                icon={<Square size={13} />}
                onClick={chat.stop}
              >
                停止
              </Button>
            ) : (
              <Button
                type="submit"
                size="small"
                variant="primary"
                icon={<ArrowUp size={16} />}
                disabled={
                  !draft.trim() || chat.historyLoading || !chat.canContinue
                }
              >
                发送
              </Button>
            )}
          </div>
        </form>
        <p className="shrink-0 text-center text-[11px] text-muted/70">
          回答基于当前可查询的信息，请以实际情况为准
        </p>
      </div>
      <aside
        className={`flex shrink-0 flex-col gap-4 border-l border-line pt-3 max-md:max-h-40 max-md:w-full max-md:border-l-0 max-md:border-t max-md:pl-0 ${showHistory ? "w-56 pl-4" : "w-12 pl-3"}`}
        aria-label="历史会话"
      >
        <div className="flex items-center justify-between">
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-sage"
            aria-label={showHistory ? "收起历史会话" : "展开历史会话"}
            title={showHistory ? "收起历史会话" : "展开历史会话"}
            aria-expanded={showHistory}
            aria-controls="agent-history"
            onClick={() => setShowHistory((value) => !value)}
          >
            {showHistory ? (
              <PanelRightClose size={17} />
            ) : (
              <PanelRightOpen size={17} />
            )}
          </button>
          {showHistory ? (
            <h2 className="ml-2 flex-1 text-xs font-medium text-muted">
              历史会话
            </h2>
          ) : null}
          {showHistory ? (
            <Button
              size="small"
              variant="ghost"
              aria-label="刷新历史会话"
              status={chat.listLoading ? "pending" : "idle"}
              icon={<RefreshCw size={14} />}
              onClick={async () => {
                await chat.loadList();
              }}
            />
          ) : null}
        </div>
        <div
          id="agent-history"
          hidden={!showHistory}
          className="min-h-0 flex-1 space-y-1 overflow-y-auto"
        >
          {chat.listLoading && !chat.threads.length ? (
            <div className="space-y-2" aria-label="正在读取历史会话">
              {[0, 1, 2].map((item) => (
                <Skeleton key={item} className="h-16 rounded-xl" />
              ))}
            </div>
          ) : null}
          {!chat.threads.length && !chat.listLoading && !chat.historyError ? (
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
          {chat.threads.map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              aria-current={
                chat.threadId === thread.threadId ? "true" : undefined
              }
              className="group block w-full rounded-xl px-3 py-3 text-left transition-colors hover:bg-surface/70 aria-[current=true]:bg-surface focus-visible:outline-2 focus-visible:outline-sage"
              onClick={async () => {
                follow.current = true;
                setDraft("");
                setValidation("");
                await chat.openHistory(thread.threadId);
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
          {chat.nextList ? (
            <Button
              size="small"
              className="w-full"
              disabled={chat.listLoading}
              onClick={async () => {
                if (chat.nextList) await chat.loadList(chat.nextList);
              }}
            >
              更多会话
            </Button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
export default function AgentPage() {
  const scope = useAtomValue(householdScopeEpochAtom);
  return <ChatWorkspace key={scope ?? "unbound"} scope={scope} />;
}
