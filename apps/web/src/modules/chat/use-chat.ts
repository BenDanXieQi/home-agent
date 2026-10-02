import { useInfiniteQuery } from "@tanstack/react-query";
import { listChatHistory, readChatHistory } from "./history";
import { useEffect, useRef, useState } from "react";
import {
  chatInputSchema,
  chatTurnSchema,
  type chatHistorySchema,
} from "@home-agent/api/contracts";
import { requestErrorMessage } from "../../messages/zh-CN";
import { RequestError } from "../../api/errors";
import { streamChat } from "./stream";

function newTurn(message: string) {
  return chatTurnSchema.parse({
    id: crypto.randomUUID(),
    message,
    answer: "",
    tools: [],
    runId: "",
    error: "",
    status: "running",
  });
}
export function useChat(scope: string | undefined) {
  const [turns, setTurns] = useState<ReturnType<typeof newTurn>[]>([]);
  const [threadId, setThreadId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [canContinue, setCanContinue] = useState(true);
  const active = useRef<AbortController | null>(null);
  const [historyPage, setHistoryPage] = useState<ReturnType<
    typeof chatHistorySchema.parse
  > | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const reading = useRef<AbortController | null>(null);
  const historyList = useInfiniteQuery({
    queryKey: ["chat-history", scope],
    enabled: scope !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listChatHistory({ before: pageParam }, signal),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  async function loadList(before?: string) {
    if (before) await historyList.fetchNextPage();
    else await historyList.refetch();
  }
  useEffect(
    () => () => {
      active.current?.abort();
      reading.current?.abort();
    },
    [],
  );
  async function send(message: string) {
    if (active.current || reading.current || !canContinue || !message.trim())
      return;
    const input = chatInputSchema.parse({ message, threadId });
    const current = new AbortController();
    active.current = current;
    setBusy(true);
    const turn = newTurn(input.message);
    setTurns((previous) => [...previous, turn]);
    function update(
      change: (value: ReturnType<typeof newTurn>) => ReturnType<typeof newTurn>,
    ) {
      if (active.current !== current) return;
      setTurns((previous) =>
        previous.map((value) => (value.id === turn.id ? change(value) : value)),
      );
    }
    try {
      await streamChat(input, current.signal, (event) => {
        if (active.current !== current || current.signal.aborted) return;
        if (event.event === "run_started") {
          setThreadId(event.threadId);
          update((value) => ({ ...value, runId: event.runId }));
        } else if (event.event === "token") {
          update((value) => ({ ...value, answer: value.answer + event.text }));
        } else if (
          event.event === "tool_started" ||
          event.event === "tool_completed"
        ) {
          if (event.event === "tool_started")
            update((value) => ({
              ...value,
              tools: [
                ...value.tools,
                {
                  callId: event.callId,
                  name: event.name,
                  input: event.input,
                  output: null,
                  truncated: false,
                },
              ],
            }));
          else
            update((value) => ({
              ...value,
              tools: value.tools.map((call) =>
                call.callId === event.callId
                  ? {
                      ...call,
                      output: event.output,
                      truncated: event.truncated,
                    }
                  : call,
              ),
            }));
        }
      });
      update((value) => ({ ...value, status: "completed" }));
    } catch (error) {
      if (active.current === current) setCanContinue(false);
      update((value) => ({
        ...value,
        status: current.signal.aborted ? "cancelled" : "failed",
        error: current.signal.aborted
          ? "已停止；本次输入或部分执行可能已保存。"
          : error instanceof RequestError
            ? requestErrorMessage(error)
            : "连接中断或返回内容无效，本次回答未完成。",
      }));
    } finally {
      if (active.current === current) {
        active.current = null;
        setBusy(false);
        await loadList();
      }
    }
  }
  function reset() {
    reading.current?.abort();
    reading.current = null;
    setHistoryLoading(false);
    setHistoryPage(null);
    setHistoryError("");
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setCanContinue(true);
    setThreadId(undefined);
    setTurns([]);
  }
  async function openHistory(id: string) {
    reset();
    setThreadId(id);
    setCanContinue(false);
    const controller = new AbortController();
    reading.current = controller;
    setHistoryLoading(true);
    try {
      const result = await readChatHistory({ threadId: id }, controller.signal);
      if (reading.current !== controller || controller.signal.aborted) return;
      setTurns(result.turns);
      setCanContinue(result.canContinue);
      setHistoryPage(result);
    } catch (error) {
      if (!controller.signal.aborted)
        setHistoryError(requestErrorMessage(error));
    } finally {
      if (reading.current === controller) {
        reading.current = null;
        setHistoryLoading(false);
      }
    }
  }
  async function loadEarlier() {
    if (
      !historyPage ||
      historyPage.nextBefore === null ||
      reading.current ||
      active.current
    )
      return;
    const controller = new AbortController();
    reading.current = controller;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await readChatHistory(
        {
          threadId: historyPage.threadId,
          checkpointId: historyPage.checkpointId,
          before: historyPage.nextBefore,
        },
        controller.signal,
      );
      if (reading.current !== controller || controller.signal.aborted) return;
      setTurns((previous) => [...result.turns, ...previous]);
      setHistoryPage(result);
    } catch (error) {
      if (!controller.signal.aborted)
        setHistoryError(requestErrorMessage(error));
    } finally {
      if (reading.current === controller) {
        reading.current = null;
        setHistoryLoading(false);
      }
    }
  }
  return {
    turns,
    canContinue,
    threadId,
    busy,
    send,
    reset,
    threads: Array.from(
      new Map(
        (historyList.data?.pages.flatMap((page) => page.threads) ?? []).map(
          (thread) => [thread.threadId, thread],
        ),
      ).values(),
    ),
    nextList: historyList.data?.pages.at(-1)?.nextBefore ?? null,
    listLoading: historyList.isFetching,
    historyLoading,
    historyError:
      historyError ||
      (historyList.error ? requestErrorMessage(historyList.error) : ""),
    loadList,
    openHistory,
    loadEarlier,
    hasEarlier:
      historyPage?.nextBefore !== null && historyPage?.nextBefore !== undefined,
    historyRunning: historyPage?.running ?? false,
    stop: () => {
      active.current?.abort();
    },
  };
}
