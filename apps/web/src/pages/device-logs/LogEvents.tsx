import { sourceLabels } from "../../modules/devices/presentation";
import { JsonData } from "../../components/json/JsonData";
import { twMerge } from "tailwind-merge";
import {
  memo,
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, m, useScroll, useReducedMotion } from "motion/react";
import { Collapsible } from "radix-ui";
import { ChevronDown } from "lucide-react";
import type { LogEntry } from "../../modules/device-history/presentation";
import { ReturnLatest } from "./ReturnLatest";
import { presentLogEntry } from "./presentation";

/** Hold the visible batch while reading history; reaching the top resumes live rows. */
export function LogEvents({
  rows,
  showDevice,
  empty,
  reading,
  onReadingChange,
  onLoadOlder,
  loadingOlder,
  paused,
}: {
  rows: LogEntry[];
  showDevice: boolean;
  empty: ReactNode;
  reading: LogEntry[] | null;
  onReadingChange: (reading: boolean) => void;
  onLoadOlder: () => void;
  loadingOlder: boolean;
  paused: boolean;
}) {
  const [baseline, setBaseline] = useState(
    () => new Set(rows.map((row) => row.id)),
  );
  const [returnCount, setReturnCount] = useState<number | null>(null);
  const returning = returnCount !== null;
  const scroller = useRef<HTMLElement>(null);
  const reducedMotion = useReducedMotion();
  const { scrollY } = useScroll({ container: scroller });
  // React schedules fresh rows separately from the urgent return-button exit.
  const visible = useDeferredValue(reading ?? rows);
  const visibleIds = useMemo(
    () => new Set(visible.map((row) => row.id)),
    [visible],
  );
  const [expanded, setExpanded] = useState(() => new Set<string>());
  const [focused, setFocused] = useState<string | null>(null);
  const previousVisibleIds = useRef(visibleIds);
  const changeExpanded = useCallback((id: string, open: boolean) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const retainedIndexes = useMemo(
    () =>
      visible.flatMap((row, index) =>
        expanded.has(row.id) || focused === row.id ? [index] : [],
      ),
    [visible, expanded, focused],
  );
  // oxlint-disable-next-line react/incompatible-library -- Read current measurements on each render.
  const virtualizer = useVirtualizer({
    useFlushSync: false,
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 100,
    getItemKey: useCallback((index: number) => visible[index]!.id, [visible]),
    overscan: 4,
    rangeExtractor: useCallback(
      (range: Parameters<typeof defaultRangeExtractor>[0]) =>
        [
          ...new Set([...defaultRangeExtractor(range), ...retainedIndexes]),
        ].toSorted((a, b) => a - b),
      [retainedIndexes],
    ),
  });
  useLayoutEffect(() => {
    // Frozen reading keeps its measurements. At turnover, use public APIs to
    // release retired measurements and immediately remeasure mounted rows.
    if ([...previousVisibleIds.current].some((id) => !visibleIds.has(id))) {
      virtualizer.measure();
      for (const element of scroller.current?.querySelectorAll<HTMLElement>(
        "[data-index]",
      ) ?? [])
        virtualizer.measureElement(element);
    }
    previousVisibleIds.current = visibleIds;
    setExpanded((previous) => {
      if ([...previous].every((id) => visibleIds.has(id))) return previous;
      return new Set([...previous].filter((id) => visibleIds.has(id)));
    });
    setFocused((previous) =>
      previous !== null && !visibleIds.has(previous) ? null : previous,
    );
  }, [visibleIds, virtualizer]);
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    reading && !returning ? undefined : () => false;
  useLayoutEffect(() => {
    if (!reading && (scroller.current?.scrollTop ?? 0) > 0)
      virtualizer.scrollToOffset(0);
  }, [visible, reading, virtualizer]);
  function resumeLatest() {
    setReturnCount(null);
    setBaseline(new Set(rows.map((row) => row.id)));
    onReadingChange(false);
  }
  function interruptReturn() {
    if (!returning) return;
    const element = scroller.current;
    if (element) virtualizer.scrollToOffset(element.scrollTop);
    setReturnCount(null);
  }
  const newestVisible = visible[0]?.id;
  const readingIds = useMemo(
    () => new Set(reading?.map((row) => row.id)),
    [reading],
  );
  const pending = useMemo(
    () =>
      reading
        ? rows.reduce(
            (count, row) => count + Number(!readingIds.has(row.id)),
            0,
          )
        : 0,
    [reading, rows, readingIds],
  );
  const shownCount = returnCount ?? pending;
  return (
    <div className="relative h-full min-h-0">
      <AnimatePresence>
        {reading ? (
          <ReturnLatest
            key="return-latest"
            returning={returning}
            count={shownCount}
            label={paused ? "回到顶部" : "返回最新记录"}
            scrollY={scrollY}
            onReturn={() => {
              scroller.current?.focus({ preventScroll: true });
              if ((scroller.current?.scrollTop ?? 0) <= 1) {
                resumeLatest();
                return;
              }
              setReturnCount(pending);
              virtualizer.scrollToOffset(0, {
                behavior: reducedMotion ? "auto" : "smooth",
              });
            }}
          />
        ) : null}
      </AnimatePresence>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- This scroll region handles native scrolling keys, not a custom widget. */}
      <section
        ref={scroller}
        aria-label="日志事件"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to focus the independently scrolling log region.
        tabIndex={0}
        className="h-full overflow-auto overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable] px-1 pb-2"
        data-empty={visible.length === 0}
        onScrollEnd={(event) => {
          if (event.currentTarget.scrollTop <= 1 && reading) resumeLatest();
        }}
        // A late scrollend from the preceding gesture must not cancel the return.
        // Only a new user scroll takes control away from the requested animation.
        onWheel={interruptReturn}
        onPointerDown={interruptReturn}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            (target.closest(
              "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
            ) ||
              (event.key === " " && target.closest("button, a[href]")))
          )
            return;
          if (
            [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
              " ",
            ].includes(event.key)
          )
            interruptReturn();
        }}
        onScroll={(event) => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
          // Start the flight as soon as smooth scrolling reaches the exact top.
          if (reading && scrollTop <= (returning ? 0 : 1)) resumeLatest();
          else if (scrollTop > 1 && !reading) onReadingChange(true);
          if (
            scrollTop > 1 &&
            scrollHeight - scrollTop - clientHeight <= clientHeight
          )
            onLoadOlder();
        }}
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = visible[item.index]!;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 flow-root w-full"
                style={{ transform: `translateY(${item.start}px)` }}
                onFocusCapture={() => setFocused(row.id)}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    setFocused(null);
                }}
              >
                <LogEvent
                  row={row}
                  showDevice={showDevice}
                  open={expanded.has(row.id)}
                  onOpenChange={changeExpanded}
                  entering={!reading && !baseline.has(row.id)}
                  highlighted={
                    !reading &&
                    row.id === newestVisible &&
                    !baseline.has(row.id)
                  }
                />
              </div>
            );
          })}
        </div>

        {loadingOlder ? (
          <output className="block py-3 text-center text-xs text-muted">
            正在读取更早记录…
          </output>
        ) : null}
        {!visible.length && empty}
      </section>
    </div>
  );
}

const LogEvent = memo(function LogEvent({
  row,
  showDevice,
  highlighted,
  entering,
  open,
  onOpenChange,
}: {
  row: LogEntry;
  showDevice: boolean;
  highlighted: boolean;
  entering: boolean;
  open: boolean;
  onOpenChange: (id: string, open: boolean) => void;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(value) => onOpenChange(row.id, value)}
      asChild
    >
      <m.article
        className={twMerge(
          `mb-3 rounded-xl bg-white shadow-surface [&_time_small]:block [&_time_small]:text-[11px] [&_time_small]:mt-1.5 overflow-hidden ${highlighted ? "animate-[report-arrival_0.75s_ease-out_both]" : ""}`,
        )}
        initial={
          entering && !reducedMotion
            ? { opacity: 0, transform: "translateY(8px)" }
            : false
        }
        animate={{ opacity: 1, transform: "translateY(0px)" }}
        transition={{
          duration: reducedMotion ? 0 : 0.24,
          ease: [0.22, 1, 0.36, 1],
        }}
      >
        <Collapsible.Trigger className="grid w-full grid-cols-[56px_minmax(0,1fr)_minmax(100px,auto)_14px] items-center gap-5 px-6 py-5 text-left hover:bg-black/[0.015] group/log-event max-[1001px]:grid-cols-[minmax(0,1fr)_14px] max-[1001px]:gap-x-4 max-[1001px]:gap-y-2 max-[1001px]:px-5 max-[1001px]:py-4">
          <time className="text-[11px] tabular-nums text-muted shrink-0 pt-0.5 max-[1001px]:col-start-1 max-[1001px]:row-start-1">
            {presentLogEntry(row).time}
          </time>
          <span className="flex min-w-0 flex-col gap-1 max-[1001px]:col-start-1 max-[1001px]:row-start-2">
            <strong className="text-[15px] font-medium leading-6">
              {row.description || row.property}
            </strong>
            {showDevice ? (
              <span className="text-xs leading-5 text-muted">
                {row.device_name}
              </span>
            ) : null}
          </span>
          <span className="flex gap-2.5 items-center text-[14px] [&_svg]:shrink-0 [&_svg]:text-muted m-0 max-w-72 flex-wrap justify-end max-[1001px]:col-start-1 max-[1001px]:row-start-3 max-[1001px]:max-w-full max-[1001px]:justify-start">
            <code className="text-sm leading-7 wrap-anywhere min-w-0">
              {row.displayValue}
            </code>
          </span>
          <ChevronDown
            className="group-data-[state=open]/log-event:rotate-180 shrink-0 text-muted transition-transform m-0 max-[1001px]:col-start-2 max-[1001px]:row-start-1"
            size={14}
            aria-hidden="true"
          />
        </Collapsible.Trigger>
        <AnimatePresence initial={false}>
          {open ? (
            <Collapsible.Content forceMount asChild>
              <m.div
                className="overflow-hidden"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{
                  duration: reducedMotion ? 0 : 0.24,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                <LogEventDetail row={row} />
              </m.div>
            </Collapsible.Content>
          ) : null}
        </AnimatePresence>
      </m.article>
    </Collapsible.Root>
  );
});

export const LogEventDetail = memo(function LogEventDetail({
  row,
  comparison = false,
}: {
  row: LogEntry;
  comparison?: boolean;
}) {
  return (
    <div
      className={twMerge(
        "max-w-3xl text-sm text-ink",
        comparison
          ? "pt-2"
          : "mx-6 mb-6 pl-[76px] pt-1 max-[1001px]:mx-5 max-[1001px]:pl-0",
      )}
    >
      <dl
        className={twMerge(
          "grid gap-x-8 text-sm leading-6",
          comparison ? "grid-cols-1 gap-y-3" : "grid-cols-2 gap-y-5",
        )}
      >
        <div>
          <dt className="text-muted">接收时间</dt>
          <dd className="mt-1 text-ink">{presentLogEntry(row).dateTime}</dd>
        </div>
        <div>
          <dt className="text-muted">记录类型</dt>
          <dd className="mt-1 text-ink">
            {row.kind === "property" ? "属性报告" : "在线状态"}
          </dd>
        </div>
        <div>
          <dt className="text-muted">来源</dt>
          <dd className="mt-1 text-ink">{sourceLabels[row.source]}</dd>
        </div>
        <div>
          <dt className="text-muted">项</dt>
          <dd className="mt-1 break-all font-mono text-ink">
            {row.property || row.kind}
          </dd>
        </div>
        <div>
          <dt className="text-muted">记录编号</dt>
          <dd className="mt-1 break-all font-mono text-ink">{row.id}</dd>
        </div>
      </dl>
      <div className="mt-6">
        <JsonData
          value={row.record}
          label="原始数据 JSON"
          name={`device-report-${row.id}`}
        />
      </div>
    </div>
  );
});
