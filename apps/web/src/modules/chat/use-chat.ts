import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { listChatHistory, readChatHistory } from "./history";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatInputSchema,
  chatTurnSchema,
  type chatHistorySchema,
  type chatHistoryListSchema,
} from "@home-agent/api/contracts";
import { requestErrorMessage } from "../../messages/zh-CN";
import { RequestError } from "../../api/errors";
import { streamChat } from "./stream";

const residentTurnLimit = 50;

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
  const [viewingEarlier, setViewingEarlier] = useState(false);
  const [canContinue, setCanContinue] = useState(true);
  const active = useRef<AbortController | null>(null);
  const [historyPage, setHistoryPage] = useState<Omit<
    ReturnType<typeof chatHistorySchema.parse>,
    "turns"
  > | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const reading = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();
  const listKey = useMemo(() => ["chat-history", scope], [scope]);
  const historyList = useInfiniteQuery({
    queryKey: listKey,
    enabled: scope !== undefined,
    initialPageParam: undefined as
      | NonNullable<
          ReturnType<typeof chatHistoryListSchema.parse>["nextBefore"]
        >
      | undefined,
    queryFn: ({ pageParam, signal }) =>
      listChatHistory({ before: pageParam }, signal),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    retry: false,
    gcTime: 0,
    maxPages: 5,
    refetchOnWindowFocus: false,
  });
  const { fetchNextPage, refetch: refetchList, data: listData } = historyList;
  const loadList = useCallback(
    async (
      before?: NonNullable<
        ReturnType<typeof chatHistoryListSchema.parse>["nextBefore"]
      >,
    ) => {
      if (before) {
        await fetchNextPage();
        return;
      }
      await queryClient.cancelQueries({ queryKey: listKey, exact: true });
      queryClient.setQueryData<typeof listData>(listKey, (data) =>
        data
          ? {
              pages: data.pages.slice(0, 1),
              pageParams: [undefined],
            }
          : data,
      );
      await refetchList();
    },
    [queryClient, listKey, fetchNextPage, refetchList],
  );
  useEffect(
    () => () => {
      active.current?.abort();
      reading.current?.abort();
    },
    [],
  );
  async function send(message: string) {
    if (
      active.current ||
      reading.current ||
      viewingEarlier ||
      !canContinue ||
      !message.trim()
    )
      return;
    const input = chatInputSchema.parse({ message, threadId });
    const current = new AbortController();
    active.current = current;
    setBusy(true);
    const turn = newTurn(input.message);
    setTurns((previous) => [...previous, turn].slice(-residentTurnLimit));
    function update(
      change: (value: ReturnType<typeof newTurn>) => ReturnType<typeof newTurn>,
    ) {
      if (active.current !== current) return;
      setTurns((previous) =>
        previous.map((value) => (value.id === turn.id ? change(value) : value)),
      );
    }
    const chunks: string[] = [];
    let frame: number | undefined;
    function flushTokens() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      if (!chunks.length) return;
      const text = chunks.splice(0).join("");
      update((value) => ({ ...value, answer: value.answer + text }));
    }
    const discardTokens = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      chunks.length = 0;
    };
    current.signal.addEventListener("abort", flushTokens, { once: true });
    try {
      await streamChat(input, current.signal, (event) => {
        if (active.current !== current || current.signal.aborted) return;
        if (event.event === "run_started") {
          setThreadId(event.threadId);
          update((value) => ({ ...value, runId: event.runId }));
        } else if (event.event === "token") {
          chunks.push(event.text);
          if (frame === undefined) frame = requestAnimationFrame(flushTokens);
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
      flushTokens();
      update((value) => ({ ...value, status: "completed" }));
    } catch (error) {
      flushTokens();
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
      discardTokens();
      current.signal.removeEventListener("abort", flushTokens);
      if (active.current === current) {
        active.current = null;
        setBusy(false);
        await loadList();
      }
    }
  }
  const reset = useCallback(() => {
    reading.current?.abort();
    reading.current = null;
    setHistoryLoading(false);
    setHistoryPage(null);
    setHistoryError("");
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setCanContinue(true);
    setViewingEarlier(false);
    setThreadId(undefined);
    setTurns([]);
  }, []);
  const openHistory = useCallback(
    async (id: string) => {
      reset();
      setThreadId(id);
      setCanContinue(false);
      const controller = new AbortController();
      reading.current = controller;
      setHistoryLoading(true);
      try {
        const result = await readChatHistory(
          { threadId: id },
          controller.signal,
        );
        if (reading.current !== controller || controller.signal.aborted) return;
        const { turns: savedTurns, ...page } = result;
        setTurns(savedTurns.slice(-residentTurnLimit));
        setCanContinue(result.canContinue);
        setHistoryPage(page);
      } catch (error) {
        if (!controller.signal.aborted)
          setHistoryError(requestErrorMessage(error));
      } finally {
        if (reading.current === controller) {
          reading.current = null;
          setHistoryLoading(false);
        }
      }
    },
    [reset],
  );
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
      const { turns: savedTurns, ...page } = result;
      setTurns(savedTurns.slice(-residentTurnLimit));
      setViewingEarlier(true);
      setHistoryPage(page);
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
  const threads = useMemo(
    () =>
      Array.from(
        new Map(
          (historyList.data?.pages.flatMap((page) => page.threads) ?? []).map(
            (thread) => [thread.threadId, thread],
          ),
        ).values(),
      ),
    [historyList.data],
  );
  return {
    turns,
    canContinue: canContinue && !viewingEarlier,
    viewingEarlier,
    residentTurnLimit,
    threadId,
    busy,
    send,
    reset,
    threads,
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
