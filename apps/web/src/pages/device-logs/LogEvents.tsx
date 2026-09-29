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
import { ArrowRight, ChevronDown } from "lucide-react";
import type { DeviceLogSnapshot } from "@home-agent/api/device-logs";
import { ReturnLatest } from "./ReturnLatest";
import { changeLabels, presentLogEntry } from "./presentation";

/** Hold the visible batch while reading history; reaching the top resumes live rows. */
export function LogEvents({
  rows,
  showDevice,
  empty,
}: {
  rows: DeviceLogSnapshot["entries"];
  showDevice: boolean;
  empty: ReactNode;
}) {
  const [baseline, setBaseline] = useState(() =>
    rows.reduce((latest, row) => Math.max(latest, row.sequence), -1),
  );
  const [reading, setReading] = useState<typeof rows | null>(null);
  const [returnCount, setReturnCount] = useState<number | null>(null);
  const returning = returnCount !== null;
  const scroller = useRef<HTMLElement>(null);
  const reducedMotion = useReducedMotion();
  const { scrollY } = useScroll({ container: scroller });
  // React schedules fresh rows separately from the urgent return-button exit.
  const visible = useDeferredValue(reading ?? rows);
  const [expanded, setExpanded] = useState(() => new Set<number>());
  const [focused, setFocused] = useState<number | null>(null);
  const changeExpanded = useCallback((sequence: number, open: boolean) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (open) next.add(sequence);
      else next.delete(sequence);
      return next;
    });
  }, []);
  const retainedIndexes = useMemo(
    () =>
      visible.flatMap((row, index) =>
        expanded.has(row.sequence) || focused === row.sequence ? [index] : [],
      ),
    [visible, expanded, focused],
  );
  // oxlint-disable-next-line react/incompatible-library -- Read the virtualizer's live measurements on every render; do not compiler-memoize this component.
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 100,
    getItemKey: useCallback(
      (index: number) => visible[index]!.sequence,
      [visible],
    ),
    overscan: 4,
    // Keep expanded details and keyboard focus mounted when scrolled offscreen.
    rangeExtractor: useCallback(
      (range: Parameters<typeof defaultRangeExtractor>[0]) =>
        [
          ...new Set([...defaultRangeExtractor(range), ...retainedIndexes]),
        ].toSorted((a, b) => a - b),
      [retainedIndexes],
    ),
  });
  // Growing rows must not move a reader who is following the newest reports.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    reading && !returning ? undefined : () => false;
  useLayoutEffect(() => {
    if (!reading && (scroller.current?.scrollTop ?? 0) > 0)
      virtualizer.scrollToOffset(0);
  }, [visible, reading, virtualizer]);
  function resumeLatest() {
    setReturnCount(null);
    setBaseline(
      rows.reduce((latest, row) => Math.max(latest, row.sequence), -1),
    );
    setReading(null);
  }
  function interruptReturn() {
    if (!returning) return;
    const element = scroller.current;
    if (element) virtualizer.scrollToOffset(element.scrollTop);
    setReturnCount(null);
  }
  const newestVisible = useMemo(
    () => visible.reduce((latest, row) => Math.max(latest, row.sequence), -1),
    [visible],
  );
  const pending = useMemo(
    () =>
      reading
        ? rows.reduce(
            (count, row) => count + Number(row.sequence > newestVisible),
            0,
          )
        : 0,
    [reading, rows, newestVisible],
  );
  const shownCount = returnCount ?? pending;
  return (
    <div className="relative">
      <AnimatePresence>
        {reading ? (
          <ReturnLatest
            key="return-latest"
            returning={returning}
            count={shownCount}
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
        className="h-[clamp(360px,_calc(100dvh_-_250px),_820px)] overflow-auto [overflow-anchor:none] [scrollbar-gutter:stable] px-1 pb-2 data-[empty=true]:h-auto data-[empty=true]:overflow-visible"
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
          const { scrollTop } = event.currentTarget;
          // Start the flight as soon as smooth scrolling reaches the exact top.
          if (reading && scrollTop <= (returning ? 0 : 1)) resumeLatest();
          else if (scrollTop > 1 && !reading) setReading(visible);
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
                onFocusCapture={() => setFocused(row.sequence)}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    setFocused(null);
                }}
              >
                <LogEvent
                  row={row}
                  showDevice={showDevice}
                  open={expanded.has(row.sequence)}
                  onOpenChange={changeExpanded}
                  entering={!reading && row.sequence > baseline}
                  highlighted={
                    !reading &&
                    row.sequence === newestVisible &&
                    row.sequence > baseline
                  }
                />
              </div>
            );
          })}
        </div>

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
  row: DeviceLogSnapshot["entries"][number];
  showDevice: boolean;
  highlighted: boolean;
  entering: boolean;
  open: boolean;
  onOpenChange: (sequence: number, open: boolean) => void;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(value) => onOpenChange(row.sequence, value)}
      asChild
    >
      <m.article
        className={twMerge(
          `mb-3 rounded-xl bg-white shadow-surface [&_time_small]:block [&_time_small]:text-[11px] [&_time_small]:mt-1.5 overflow-hidden ${highlighted ? "animate-[report-arrival_0.75s_ease-out_both]" : ""}`,
        )}
        initial={
          entering && !reducedMotion
            ? { height: 0, opacity: 0, marginBottom: 0 }
            : false
        }
        animate={{ height: "auto", opacity: 1, marginBottom: 12 }}
        exit={{
          height: 0,
          opacity: 0,
          marginBottom: 0,
          transition: { duration: reducedMotion ? 0 : 0.18 },
        }}
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
              {row.description || row.property || "连接记录"}
            </strong>
            {showDevice ? (
              <span className="text-xs leading-5 text-muted">
                {row.device_name}
              </span>
            ) : null}
          </span>
          <span className="flex gap-2.5 items-center text-[14px] [&_svg]:shrink-0 [&_svg]:text-muted m-0 max-w-72 flex-wrap justify-end max-[1001px]:col-start-1 max-[1001px]:row-start-3 max-[1001px]:max-w-full max-[1001px]:justify-start">
            {row.change === "changed" && (
              <>
                <code className="text-sm leading-7 wrap-anywhere min-w-0 text-muted">
                  {row.previous_value}
                </code>
                <ArrowRight size={13} aria-label="变为" />
              </>
            )}
            <code className="text-sm leading-7 wrap-anywhere min-w-0">
              {row.value}
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
  row: DeviceLogSnapshot["entries"][number];
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
          <dt className="text-muted">上报类型</dt>
          <dd className="mt-1 text-ink">{changeLabels[row.change]}</dd>
        </div>
        <div>
          <dt className="text-muted">属性标识</dt>
          <dd className="mt-1 break-all font-mono text-ink">
            {row.property || row.kind}
          </dd>
        </div>
        <div>
          <dt className="text-muted">记录编号</dt>
          <dd className="mt-1 text-ink">#{row.sequence}</dd>
        </div>
      </dl>
      <details className="group/raw mt-6">
        <summary className="flex min-h-10 cursor-pointer items-center gap-3 text-sm font-medium text-ink list-none before:content-['+'] before:text-lg before:font-normal group-open/raw:before:content-['−'] [&::-webkit-details-marker]:hidden">
          查看原始数据 <span className="text-muted">JSON</span>
        </summary>
        {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The raw JSON pane scrolls independently and must be keyboard accessible. */}
        <pre
          className="my-3 max-h-96 overflow-auto whitespace-pre-wrap break-all bg-transparent p-0 font-mono text-[13px] leading-7 text-ink [scrollbar-gutter:stable]"
          tabIndex={0}
          aria-label={`第 ${row.sequence} 条原始数据`}
        >
          {JSON.stringify(row.observation, null, 2)}
        </pre>
        {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
      </details>
    </div>
  );
});
