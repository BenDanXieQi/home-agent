import { useCallback, useEffect, useRef, useState } from "react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { ChatTurn } from "./ChatTurn";
import { ChatHistory } from "./ChatHistory";
import { useAtomValue } from "jotai";
import {
  ArrowUp,
  House,
  Users,
  LampDesk,
  ArrowRight,
  Plus,
  Square,
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
function ChatWorkspace({ scope }: { scope: string | undefined }) {
  const chat = useChat(scope);
  const [draft, setDraft] = useState("");
  const [validation, setValidation] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const openChatHistory = chat.openHistory;
  const openHistory = useCallback(
    async (id: string) => {
      follow.current = true;
      setDraft("");
      setValidation("");
      await openChatHistory(id);
    },
    [openChatHistory],
  );
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
    <div className="flex h-full min-h-0 gap-5 max-md:flex-col max-md:gap-3">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <PageHeaderContent slot="details">
          <span className="text-xs text-muted">你的家庭助手</span>
        </PageHeaderContent>
        <PageHeaderContent slot="actions">
          <Button
            size="small"
            variant="ghost"
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
          <Notice tone="error" className="mb-0 items-start px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">暂时无法读取会话</p>
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer">查看原因</summary>
                <p className="mt-2 break-words">{chat.historyError}</p>
              </details>
            </div>
            <Button
              size="small"
              onClick={async () => {
                if (chat.threadId) await chat.openHistory(chat.threadId);
                else await chat.loadList();
              }}
            >
              重试
            </Button>
          </Notice>
        ) : null}
        {chat.historyLoading ? (
          <output className="text-xs text-muted">正在读取历史消息…</output>
        ) : null}
        {!chat.canContinue &&
        !chat.busy &&
        !chat.historyLoading &&
        !chat.historyError ? (
          <output className="mx-auto flex w-full max-w-3xl shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line py-2 text-xs leading-5 text-muted">
            <span>
              {chat.viewingEarlier
                ? "正在查看较早消息，返回最新消息后可继续提问。"
                : chat.historyRunning
                  ? "会话仍在执行，可重新加载查看进展。"
                  : "只读会话 · 执行未完成，可新建对话继续提问。"}
            </span>
            {chat.threadId ? (
              <Button
                size="small"
                variant="ghost"
                onClick={async () => {
                  if (chat.threadId) await chat.openHistory(chat.threadId);
                }}
              >
                重新加载
              </Button>
            ) : null}
          </output>
        ) : null}
        <div
          ref={scroller}
          onScroll={() => {
            const el = scroller.current;
            if (el)
              follow.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          aria-label="对话记录"
        >
          {chat.threadId &&
          (chat.viewingEarlier ||
            chat.turns.length >= chat.residentTurnLimit) ? (
            <div className="mb-4 flex items-center gap-3 text-xs text-muted">
              <span>
                {chat.viewingEarlier
                  ? "较早消息按页展示"
                  : `页面最多保留最近 ${chat.residentTurnLimit} 轮`}
              </span>
              <Button
                size="small"
                disabled={chat.historyLoading || chat.busy}
                onClick={async () => {
                  if (chat.threadId) await openHistory(chat.threadId);
                }}
              >
                {chat.viewingEarlier ? "返回最新消息" : "浏览已保存消息"}
              </Button>
            </div>
          ) : null}
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
            <section className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center py-8 max-md:py-4">
              <div className="flex items-center gap-3">
                <AgentAvatar className="size-10 text-ink" />
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">
                    有什么想了解的？
                  </h2>
                  <p className="mt-1 text-[13px] leading-6 text-muted">
                    查询家里的设备状态、房间和成员资料。
                  </p>
                </div>
              </div>
              <div className="mt-6 overflow-hidden rounded-xl border border-line">
                {prompts.map(({ icon: Icon, title, message }) => (
                  <button
                    key={message}
                    type="button"
                    className="group flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-surface focus-visible:outline-offset-[-2px]"
                    onClick={() => {
                      setDraft(message);
                      input.current?.focus();
                    }}
                  >
                    <Icon
                      size={17}
                      strokeWidth={1.5}
                      className="shrink-0 text-muted"
                    />
                    <div className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium">
                        {title}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-muted">
                        {message}
                      </span>
                    </div>
                    <ArrowRight
                      size={15}
                      className="shrink-0 text-muted/60 group-hover:text-ink"
                    />
                  </button>
                ))}
              </div>
              <p className="mt-3 text-xs leading-5 text-muted">
                目前支持信息查询，设备控制和人物、宠物定位尚未接入。
              </p>
            </section>
          ) : (
            <div className="mx-auto max-w-3xl space-y-8 py-5">
              {chat.turns.map((turn) => (
                <ChatTurn key={turn.id} turn={turn} />
              ))}
            </div>
          )}
        </div>
        <form
          className="mx-auto w-full max-w-3xl shrink-0"
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
          <div className="flex items-end gap-2 rounded-xl border border-line bg-paper p-1.5 focus-within:border-ink/30">
            <textarea
              id="agent-message"
              ref={input}
              value={draft}
              maxLength={16_000}
              disabled={chat.historyLoading || !chat.canContinue}
              rows={1}
              placeholder="问问家里的情况…"
              title="Enter 发送，Shift + Enter 换行"
              className="field-sizing-content min-h-8 max-h-40 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] leading-5 outline-none placeholder:text-muted/60 disabled:text-muted"
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
            {chat.busy ? (
              <Button
                type="button"
                size="small"
                variant="ghost"
                className="rounded-lg"
                aria-label="停止回答"
                title="停止回答"
                icon={<Square size={13} />}
                onClick={chat.stop}
              />
            ) : (
              <Button
                type="submit"
                size="small"
                className="rounded-lg disabled:border-transparent disabled:bg-transparent disabled:text-muted/40 disabled:opacity-100"
                variant="primary"
                aria-label="发送消息"
                title="发送消息"
                icon={<ArrowUp size={16} />}
                disabled={
                  !draft.trim() || chat.historyLoading || !chat.canContinue
                }
              />
            )}
          </div>
          {validation ? (
            <p role="alert" className="mt-2 text-xs text-danger">
              {validation}
            </p>
          ) : null}
        </form>
      </div>
      <ChatHistory
        threads={chat.threads}
        threadId={chat.threadId}
        listLoading={chat.listLoading}
        historyError={chat.historyError}
        nextList={chat.nextList}
        loadList={chat.loadList}
        onOpen={openHistory}
      />
    </div>
  );
}
export default function AgentPage() {
  const scope = useAtomValue(householdScopeEpochAtom);
  return <ChatWorkspace key={scope ?? "unbound"} scope={scope} />;
}
