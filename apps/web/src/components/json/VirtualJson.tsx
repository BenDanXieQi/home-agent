import { Copy } from "lucide-react";
import { JsonExport } from "./JsonExport";
import { JsonToolbar } from "./JsonReading";
import { memo, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "../Button";
import {
  jsonFont,
  jsonLineHeight,
  type JsonLayoutRequest,
} from "./json-layout";
import type { layoutJson } from "./json-format.worker";

export const VirtualJson = memo(function VirtualJson({
  value,
  name,
  live = false,
}: {
  value: unknown;
  name: string;
  live?: boolean;
}) {
  const scroller = useRef<HTMLElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [reading, setReading] = useState<{
    value: unknown;
    result: ReturnType<typeof layoutJson>;
    json: string;
  } | null>(null);
  const displayedReading =
    reading && (live || reading.value === value) ? reading : null;
  const result = displayedReading?.result ?? null;
  const json = displayedReading?.json ?? "";
  const [resizing, setResizing] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{
    value: unknown;
    status: "copied" | "failed";
  } | null>(null);
  const copyStatus =
    copyFeedback && copyFeedback.value === value ? copyFeedback.status : "idle";
  const alive = useRef(true);
  const updateValue = useRef<((next: unknown) => void) | null>(null);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    let worker: Worker | undefined;
    let observer: ResizeObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    let latest: { value: unknown } | undefined;
    let prepared: typeof latest;
    let requestId = 0;
    let previousWidth = 0;
    let inFlight = false;
    let appliedWidth = 0;
    let formattedJson = "";
    function setResult(output: ReturnType<typeof layoutJson>) {
      setReading({
        value: prepared?.value,
        result: output,
        json: formattedJson,
      });
    }
    function fail(error: string) {
      active = false;
      worker?.terminate();
      observer?.disconnect();
      clearTimeout(timer);
      const failure = { kind: "failed" as const, requestId, error };
      updateValue.current = (next) => {
        setReading({ value: next, result: failure, json: "" });
      };
      setReading({ value: latest?.value, result: failure, json: "" });
      setResizing(false);
    }
    alive.current = true;
    updateValue.current = (next) => {
      latest = { value: next };
    };
    try {
      worker = new Worker(new URL("./json-format.worker.ts", import.meta.url), {
        type: "module",
      });
      const current = worker;
      function sendLayout() {
        if (
          !active ||
          inFlight ||
          previousWidth <= 0 ||
          !latest ||
          (previousWidth === appliedWidth && latest === prepared)
        )
          return;
        clearTimeout(timer);
        const request: JsonLayoutRequest =
          latest === prepared
            ? { kind: "resize", requestId: ++requestId, width: previousWidth }
            : {
                kind: "prepare",
                requestId: ++requestId,
                width: previousWidth,
                value: latest.value,
                locale: document.documentElement.lang || "zh-CN",
              };
        try {
          inFlight = true;
          prepared = latest;
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated worker messaging has no targetOrigin.
          current.postMessage(request);
        } catch {
          fail("无法读取 JSON，请重新读取。");
        }
      }
      current.addEventListener(
        "message",
        (event: MessageEvent<ReturnType<typeof layoutJson>>) => {
          if (!active || event.data.requestId !== requestId) return;
          inFlight = false;
          if (event.data.kind === "failed") {
            fail(event.data.error);
            return;
          }
          if (event.data.json !== undefined) formattedJson = event.data.json;
          appliedWidth = event.data.width;
          if (appliedWidth === previousWidth) {
            setResult(event.data);
            setResizing(false);
            sendLayout();
          } else {
            // One in-flight layout, plus only the latest requested width.
            sendLayout();
          }
        },
      );
      current.addEventListener(
        "error",
        () => {
          if (!active) return;
          fail("JSON 排版失败，请重新读取。");
        },
        { once: true },
      );
      current.addEventListener(
        "messageerror",
        () => {
          if (active) fail("无法接收 JSON 排版结果，请重新读取。");
        },
        { once: true },
      );
      updateValue.current = (next) => {
        latest = { value: next };
        sendLayout();
      };
      observer = new ResizeObserver(([entry]) => {
        if (!active || !entry) return;
        const width = Math.floor(entry.contentRect.width);
        if (width <= 0 || width === previousWidth) return;
        previousWidth = width;
        setResizing(inFlight || width !== appliedWidth);
        clearTimeout(timer);
        timer = setTimeout(sendLayout, prepared ? 100 : 0);
      });
      observer.observe(element);
    } catch {
      queueMicrotask(() => {
        if (active) fail("无法启动 JSON 阅读器，请重新读取。");
      });
    }
    return () => {
      active = false;
      updateValue.current = null;
      alive.current = false;
      clearTimeout(timer);
      observer?.disconnect();
      worker?.terminate();
    };
  }, [attempt]);
  useEffect(() => {
    updateValue.current?.(value);
  }, [value, attempt]);
  const lines = result?.kind === "ready" ? result.lines : [];
  // oxlint-disable-next-line react/incompatible-library -- Read the virtualizer's current visible range on each render.
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => jsonLineHeight,
    overscan: 8,
    useFlushSync: false,
  });
  async function copyJson() {
    if (result?.kind !== "ready") return;
    try {
      await navigator.clipboard.writeText(json);
      if (alive.current) setCopyFeedback({ value, status: "copied" });
    } catch {
      if (alive.current) setCopyFeedback({ value, status: "failed" });
    }
  }
  return (
    <div className="space-y-2">
      <JsonToolbar
        status={
          result?.kind === "ready"
            ? `${json.length.toLocaleString()} 字符${resizing ? " · 排版中…" : ""}`
            : result?.kind === "failed"
              ? result.error
              : "正在格式化…"
        }
      >
        <JsonExport
          source={
            result?.kind === "ready"
              ? { kind: "formatted", json }
              : { kind: "value", value }
          }
          name={name}
        />
        {result?.kind === "failed" ? (
          <Button
            size="small"
            onClick={() => {
              setReading(null);
              setAttempt((previous) => previous + 1);
            }}
          >
            重新读取 JSON
          </Button>
        ) : null}
        <Button
          size="small"
          disabled={result?.kind !== "ready"}
          icon={<Copy size={14} />}
          onClick={copyJson}
        >
          {copyStatus === "copied" ? "已复制到剪贴板" : "复制 JSON 内容"}
        </Button>
      </JsonToolbar>
      {copyStatus === "failed" ? (
        <p role="alert" className="text-xs text-danger">
          复制失败，请检查浏览器剪贴板权限，或下载 JSON 文件。
        </p>
      ) : null}
      <section
        ref={scroller}
        aria-label="完整 JSON 连续滚动阅读区"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- This scrollable text region needs keyboard scrolling without focusing a virtual row.
        tabIndex={0}
        className="h-96 min-w-0 overflow-auto rounded-xl bg-surface p-3 focus-visible:outline-2 focus-visible:outline-accent"
        style={{
          font: jsonFont,
          lineHeight: `${jsonLineHeight}px`,
          letterSpacing: 0,
          fontKerning: "normal",
          scrollbarGutter: "stable",
        }}
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-json-line={row.index}
              className="absolute left-0 top-0 whitespace-pre"
              style={{
                height: jsonLineHeight,
                transform: `translateY(${row.start}px)`,
              }}
            >
              {lines[row.index]}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
});
