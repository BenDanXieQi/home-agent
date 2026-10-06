import { useEffect, useMemo, useRef, useState } from "react";
import { deviceHistoryQuerySchema } from "@home-agent/api/device-history";
import { parseRetryAfter } from "@home-agent/api/http/retry-after";
import { RequestError } from "../../api/errors";
import {
  applyHistoryChange,
  appendHistoryPage,
  shareHistoryPage,
  type HistoryQuery,
  type HistoryResponse,
} from "./page";
import { historyStreamSilenceMs, streamDeviceHistory } from "./stream";

function historyKey(scope: string, input: HistoryQuery) {
  return JSON.stringify([scope, input]);
}

function firstPage(key: string) {
  return {
    key,
    cursor: undefined as string | undefined,
    revision: 0,
  };
}

function pageIdentity(key: string, cursor: string | undefined) {
  return JSON.stringify([key, cursor]);
}

/** Owns one current history stream, its live head, and its appended history continuation. */
export function useDeviceHistory(
  scope: string,
  input: HistoryQuery,
  ready: boolean,
  live: boolean,
) {
  const key = historyKey(scope, input);
  // The frozen interval survives device/kind changes; only an explicit range or scope change resets it.
  const rangeKey = JSON.stringify([scope, input.start, input.end]);
  const [savedRange, setSavedRange] = useState({
    key: rangeKey,
    end: input.end,
  });
  const range =
    savedRange.key === rangeKey
      ? savedRange
      : { key: rangeKey, end: input.end };
  if (savedRange.key !== rangeKey) setSavedRange(range);
  const [pagination, setPagination] = useState(() => firstPage(key));
  const page = pagination.key === key ? pagination : firstPage(key);
  if (pagination.key !== key) setPagination(page);
  const cursor = page.cursor;
  const pageKey = pageIdentity(key, cursor);
  const queryInputKey = JSON.stringify({ ...input, end: range.end, cursor });
  const queryInput = useMemo(
    () => deviceHistoryQuerySchema.parse(JSON.parse(queryInputKey)),
    [queryInputKey],
  );
  const displayScopeKey = JSON.stringify([
    scope,
    { ...input, kinds: undefined },
  ]);
  const delivery = live && !cursor ? "live" : "page";
  const [displayed, setDisplayed] = useState<{
    key: string;
    readingKey: string;
    displayScopeKey: string;
    input: HistoryQuery;
    data: HistoryResponse;
  }>();
  const savedData = useRef<typeof displayed>(undefined);
  const accumulated = useRef<{ key: string; data: HistoryResponse }>(undefined);
  const advancing = useRef(false);
  const cancellation = useRef<(() => void) | undefined>(undefined);
  const retryDeadline = useRef(0);
  const [status, setStatus] = useState({
    key: pageKey,
    error: null as unknown,
    isFetching: false,
    reconnecting: false,
    connected: false,
  });
  const data = displayed?.key === pageKey ? displayed.data : undefined;
  const currentStatus =
    status.key === pageKey
      ? status
      : {
          key: pageKey,
          error: null,
          isFetching: false,
          reconnecting: false,
          connected: false,
        };

  // oxlint-disable react/exhaustive-effect-dependencies -- Revision explicitly restarts the owned stream for retry.
  useEffect(() => {
    if (!ready) return undefined;
    let stopped = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stable: ReturnType<typeof setTimeout> | undefined;
    let delay = 1_000;
    let nextAllowedAt = retryDeadline.current;
    let lastMessage = Date.now();
    let synchronized = false;
    let currentPage =
      savedData.current?.key === pageKey ? savedData.current.data : undefined;
    const state = (
      error: unknown,
      isFetching: boolean,
      reconnecting: boolean,
      connected: boolean,
    ) => {
      if (!stopped)
        setStatus({ key: pageKey, error, isFetching, reconnecting, connected });
    };
    function start() {
      connect().catch((error: unknown) => {
        state(error, false, false, false);
      });
    }
    function scheduleReconnect() {
      nextAllowedAt = Math.max(
        nextAllowedAt,
        Date.now() + delay + Math.random() * 250,
      );
      retryDeadline.current = nextAllowedAt;
      delay = Math.min(delay * 2, 30_000);
      start();
    }
    async function connect() {
      if (stopped || controller) return;
      clearTimeout(timer);
      const wait = nextAllowedAt - Date.now();
      if (wait > 0) {
        timer = setTimeout(start, Math.min(wait, 2_147_483_647));
        return;
      }
      const current = new AbortController();
      controller = current;
      synchronized = false;
      lastMessage = Date.now();
      state(null, true, Boolean(currentPage), false);
      let failure: unknown = new RequestError({ code: "network_error" });
      const active = () =>
        !stopped && controller === current && !current.signal.aborted;
      try {
        await streamDeviceHistory(
          queryInput,
          delivery,
          current.signal,
          (event) => {
            if (!active()) return;
            lastMessage = Date.now();
            if (event.event === "page") {
              currentPage = shareHistoryPage(currentPage, event.data);
              synchronized = true;
              clearTimeout(stable);
              stable = setTimeout(() => {
                if (active()) delay = 1_000;
              }, 60_000);
            } else if (event.event === "change") {
              if (!synchronized || !currentPage)
                throw new RequestError({ code: "invalid_response" });
              currentPage = applyHistoryChange(currentPage, event.data);
            } else {
              return;
            }
            savedData.current = {
              key: pageKey,
              readingKey: key,
              displayScopeKey,
              input: queryInput,
              data: currentPage,
            };
            const previous = accumulated.current;
            const result =
              cursor && previous?.key === key
                ? appendHistoryPage(previous.data, currentPage)
                : currentPage;
            accumulated.current = { key, data: result };
            setDisplayed({ ...savedData.current, data: result });
            advancing.current = false;
            state(null, false, false, delivery === "live");
          },
          (response) => {
            if (response.status === 503) {
              nextAllowedAt = Math.max(
                nextAllowedAt,
                Date.now() +
                  (parseRetryAfter(response.headers.get("Retry-After")) ??
                    30_000),
              );
              retryDeadline.current = nextAllowedAt;
            }
          },
        );
      } catch (error) {
        failure = error;
        advancing.current = false;
        if (!stopped && controller === current && delivery === "page")
          state(error, false, false, false);
      } finally {
        clearTimeout(stable);
        current.abort();
        if (controller === current) {
          controller = undefined;
          synchronized = false;
          if (!stopped && delivery === "live") {
            const terminal =
              failure instanceof RequestError &&
              failure.status !== undefined &&
              [400, 401, 403].includes(failure.status);
            state(failure, false, !terminal, false);
            if (!terminal) scheduleReconnect();
          }
        }
      }
    }
    const visibility = () => {
      if (delivery !== "live" || document.visibilityState !== "visible") return;
      if (controller) {
        if (Date.now() - lastMessage > historyStreamSilenceMs)
          controller.abort();
      } else if (!synchronized) start();
    };
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(stable);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
    cancellation.current = stop;
    document.addEventListener("visibilitychange", visibility);
    start();
    return () => {
      stop();
      if (cancellation.current === stop) cancellation.current = undefined;
    };
  }, [
    ready,
    page.revision,
    queryInput,
    delivery,
    pageKey,
    displayScopeKey,
    key,
    cursor,
  ]);

  // oxlint-enable react/exhaustive-effect-dependencies

  // Keep a completed result and its query together while only the kind changes.
  // Other household, device, range changes clear it.
  const display =
    displayed?.displayScopeKey === displayScopeKey ? displayed : undefined;
  const displayInput = display
    ? { ...display.input, start: display.data.start, end: display.data.end }
    : undefined;
  return {
    data,
    displayData: display?.data,
    displayPageKey: display?.readingKey ?? key,
    displayInput,
    range: { start: input.start, end: range.end },
    error: currentStatus.error,
    isFetching: ready && currentStatus.isFetching,
    isPending: !data,
    connected: ready && currentStatus.connected,
    reconnecting: ready && currentStatus.reconnecting,
    hasNext: Boolean(data?.next_cursor),
    loadingOlder: ready && Boolean(cursor) && currentStatus.isFetching,
    refresh: () => {
      cancellation.current?.();
      advancing.current = false;
      setStatus({
        key: pageKey,
        error: null,
        isFetching: true,
        reconnecting: false,
        connected: false,
      });
      setPagination({ ...page, revision: page.revision + 1 });
    },
    latest: () => {
      cancellation.current?.();
      advancing.current = false;
      accumulated.current = undefined;
      setSavedRange({ key: rangeKey, end: input.end });
      setPagination({
        ...firstPage(key),
        revision: page.revision + 1,
      });
    },
    loadOlder: () => {
      if (!data?.next_cursor || currentStatus.isFetching || advancing.current)
        return;
      advancing.current = true;
      cancellation.current?.();
      setSavedRange({ key: rangeKey, end: data.end });
      setPagination({
        ...page,
        cursor: data.next_cursor,
      });
    },
  };
}
