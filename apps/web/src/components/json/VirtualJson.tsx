import { JsonExport } from "./JsonExport";
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
}: {
  value: unknown;
  name: string;
}) {
  const scroller = useRef<HTMLElement>(null);
  const [reading, setReading] = useState<{
    value: unknown;
    result: ReturnType<typeof layoutJson>;
    json: string;
  } | null>(null);
  const displayedReading = reading && reading.value === value ? reading : null;
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
  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    let worker: Worker | undefined;
    let observer: ResizeObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    let initialized = false;
    let requestId = 0;
    let previousWidth = 0;
    let inFlight = false;
    let appliedWidth = 0;
    let formattedJson = "";
    function setResult(output: ReturnType<typeof layoutJson>) {
      setReading({ value, result: output, json: formattedJson });
    }
    alive.current = true;
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
          previousWidth === appliedWidth
        )
          return;
        clearTimeout(timer);
        const request: JsonLayoutRequest = initialized
          ? { kind: "resize", requestId: ++requestId, width: previousWidth }
          : {
              kind: "prepare",
              requestId: ++requestId,
              width: previousWidth,
              value,
              locale: document.documentElement.lang || "zh-CN",
            };
        try {
          inFlight = true;
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated worker messaging has no targetOrigin.
          current.postMessage(request);
          initialized = true;
        } catch {
          current.terminate();
          observer?.disconnect();
          setResult({
            kind: "failed",
            requestId,
            error: "无法读取 JSON，请重新读取。",
          });
          setResizing(false);
        }
      }
      current.addEventListener(
        "message",
        (event: MessageEvent<ReturnType<typeof layoutJson>>) => {
          if (!active || event.data.requestId !== requestId) return;
          inFlight = false;
          if (event.data.kind === "failed") {
            setResult(event.data);
            setResizing(false);
            current.terminate();
            observer?.disconnect();
            clearTimeout(timer);
            return;
          }
          if (event.data.json !== undefined) formattedJson = event.data.json;
          appliedWidth = event.data.width;
          if (appliedWidth === previousWidth) {
            setResult(event.data);
            setResizing(false);
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
          setResult({
            kind: "failed",
            requestId,
            error: "JSON 排版失败，请重新读取。",
          });
          setResizing(false);
          current.terminate();
          observer?.disconnect();
          clearTimeout(timer);
        },
        { once: true },
      );
      observer = new ResizeObserver(([entry]) => {
        if (!active || !entry) return;
        const width = Math.floor(entry.contentRect.width);
        if (width <= 0 || width === previousWidth) return;
        previousWidth = width;
        setResizing(inFlight || width !== appliedWidth);
        clearTimeout(timer);
        timer = setTimeout(sendLayout, initialized ? 100 : 0);
      });
      observer.observe(element);
    } catch {
      worker?.terminate();
      queueMicrotask(() => {
        if (active)
          setResult({
            kind: "failed",
            requestId,
            error: "无法启动 JSON 阅读器，请重新读取。",
          });
      });
    }
    return () => {
      active = false;
      alive.current = false;
      clearTimeout(timer);
      observer?.disconnect();
      worker?.terminate();
    };
  }, [value]);
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <output>
          {result?.kind === "ready"
            ? `${json.length.toLocaleString()} 字符${resizing ? " · 排版中…" : ""}`
            : result?.kind === "failed"
              ? result.error
              : "正在格式化…"}
        </output>
        <div className="flex flex-wrap items-center gap-2">
          {result?.kind === "ready" ? (
            <JsonExport source={{ kind: "formatted", json }} name={name} />
          ) : null}
          <Button
            size="small"
            disabled={result?.kind !== "ready"}
            onClick={copyJson}
          >
            {copyStatus === "copied" ? "已复制" : "复制 JSON"}
          </Button>
        </div>
      </div>
      {copyStatus === "failed" ? (
        <p role="alert" className="text-xs text-danger">
          复制失败，请检查浏览器剪贴板权限，或使用详情中的 JSON 导出。
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
