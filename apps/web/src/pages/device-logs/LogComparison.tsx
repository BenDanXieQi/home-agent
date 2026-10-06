import { groupLogEntriesBySecond, maximumComparedDevices } from "./log-data";
import { twMerge } from "tailwind-merge";

import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { Activity, Columns2, RotateCcw, X } from "lucide-react";
import type { LogEntry } from "../../modules/device-history/presentation";
import { EmptyState } from "../../components/EmptyState";
import { contentSwap, expand } from "../../utils/motion";
import { LogEventDetail } from "./LogEvents";
import { time, presentLogEntry } from "./presentation";
import type { useLogComparison } from "./use-log-comparison";

const compareColors = [
  "[--compare-color:var(--color-ink)]",
  "[--compare-color:#606060]",
  "[--compare-color:#909090]",
  "[--compare-color:#bababa]",
];

export function ComparisonSelection({
  comparison,
}: {
  comparison: ReturnType<typeof useLogComparison>;
}) {
  const reducedMotion = useReducedMotion();
  const { comparing, compareIds, compareDevices, toggleComparison } =
    comparison;
  return (
    <AnimatePresence initial={false}>
      {comparing && (
        <m.div key="tray" className="overflow-hidden" {...expand}>
          <div
            className="relative flex items-center flex-wrap gap-y-1.5 gap-x-2 pt-1 px-4 pb-2 [&_>_span]:text-[11px] [&_>_span]:text-muted"
            aria-label="对比设备"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {compareDevices.map((device, index) => (
                <m.button
                  key={device.id}
                  layout
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{
                    opacity: 0,
                    scale: 0.85,
                    transition: { duration: 0.16 },
                  }}
                  className={twMerge(
                    `min-h-7.5 inline-flex items-center gap-1.5 border border-line rounded-lg py-1 px-2 bg-transparent text-[12px] cursor-pointer max-w-full wrap-anywhere text-left hover:bg-sidebar [&_svg]:shrink-0 ${compareColors[index]}`,
                  )}
                  onClick={() => toggleComparison(device.id)}
                  aria-label={`移除对比设备：${device.room} · ${device.name}`}
                  title={device.id}
                >
                  <i
                    className="w-1.5 h-1.5 rounded-full bg-[var(--compare-color)] shrink-0"
                    aria-hidden="true"
                  />
                  <span>{device.name}</span>
                  <span className="text-muted text-[11px]">{device.room}</span>
                  <X size={12} aria-hidden="true" />
                </m.button>
              ))}
              {compareIds.length < maximumComparedDevices && (
                <m.span
                  key="compare-hint"
                  className="w-[13em] max-w-full"
                  layout="position"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    opacity: { duration: reducedMotion ? 0 : 0.2 },
                    layout: { type: "spring", duration: 0.34, bounce: 0 },
                  }}
                >
                  <AnimatePresence initial={false} mode="wait">
                    <m.span
                      key={compareIds.length < 2 ? "hint-min" : "hint-more"}
                      className="block"
                      initial={{ opacity: 0 }}
                      animate={{
                        opacity: 1,
                        transition: {
                          duration: reducedMotion ? 0 : 0.24,
                          ease: "easeOut",
                        },
                      }}
                      exit={{
                        opacity: 0,
                        transition: {
                          duration: reducedMotion ? 0 : 0.12,
                          ease: "easeIn",
                        },
                      }}
                    >
                      {compareIds.length < 2
                        ? `从左侧选择 2–${maximumComparedDevices} 台设备`
                        : "可从左侧继续添加设备"}
                    </m.span>
                  </AnimatePresence>
                </m.span>
              )}
              {compareIds.length > 0 && (
                <m.button
                  key="clear"
                  layout="position"
                  className="inline-flex items-center gap-1.25 min-h-7.5 py-1 px-2 rounded-lg border-0 bg-transparent text-ink text-[11px] cursor-pointer hover:bg-sidebar"
                  onClick={() => {
                    comparison.clearComparison();
                  }}
                  {...contentSwap}
                >
                  <RotateCcw
                    size={13}
                    className="shrink-0"
                    aria-hidden="true"
                  />
                  清空选择
                </m.button>
              )}
            </AnimatePresence>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable comparison region must be keyboard accessible. */
export const LogComparison = memo(function LogComparison({
  devices,
  rows,
  anchor,
  onAnchor,
  reading,
  onReadingChange,
  onLoadOlder,
  loadingOlder,
}: Pick<ReturnType<typeof useLogComparison>, "anchor"> & {
  devices: ReturnType<typeof useLogComparison>["compareDevices"];
  rows: LogEntry[];
  onAnchor: ReturnType<typeof useLogComparison>["setAnchor"];
  reading: boolean;
  onReadingChange: (reading: boolean) => void;
  onLoadOlder: () => void;
  loadingOlder: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!reading) scroller.current?.scrollTo({ top: 0 });
  }, [reading]);
  const { buckets, counts, ids } = useMemo(
    () => groupLogEntriesBySecond(rows),
    [rows],
  );
  const body = useRef<HTMLTableSectionElement>(null);
  const heading = useRef<HTMLTableSectionElement>(null);
  const caption = useRef<HTMLTableCaptionElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [expanded, setExpanded] = useState(() => new Set<string>());
  const [focused, setFocused] = useState<number | null>(null);
  const focusedIndex = useMemo(
    () => buckets.findIndex(([second]) => second === focused),
    [buckets, focused],
  );
  // oxlint-disable-next-line react/incompatible-library -- Read current measurements on each render.
  const virtualizer = useVirtualizer({
    useFlushSync: false,
    count: buckets.length,
    getScrollElement: () => scroller.current,
    getItemKey: useCallback((index: number) => buckets[index]![0], [buckets]),
    estimateSize: () => 220,
    scrollMargin,
    overscan: 4,
    rangeExtractor: useCallback(
      (range: Parameters<typeof defaultRangeExtractor>[0]) =>
        [
          ...new Set([
            ...defaultRangeExtractor(range),
            ...(focusedIndex < 0 ? [] : [focusedIndex]),
          ]),
        ].toSorted((left, right) => left - right),
      [focusedIndex],
    ),
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = reading
    ? undefined
    : () => false;
  const available = devices.length >= 2 && rows.length > 0;
  useLayoutEffect(() => {
    if (!available) return undefined;
    const measure = () => {
      if (body.current && scroller.current)
        setScrollMargin(
          body.current.getBoundingClientRect().top -
            scroller.current.getBoundingClientRect().top +
            scroller.current.scrollTop,
        );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (heading.current) observer.observe(heading.current);
    if (caption.current) observer.observe(caption.current);
    return () => observer.disconnect();
  }, [available]);
  const previousBuckets = useRef(new Set<number>());
  useLayoutEffect(() => {
    const current = new Set(buckets.map(([second]) => second));
    if ([...previousBuckets.current].some((second) => !current.has(second))) {
      virtualizer.measure();
      for (const element of body.current?.querySelectorAll<HTMLTableRowElement>(
        "[data-index]",
      ) ?? [])
        virtualizer.measureElement(element);
    }
    previousBuckets.current = current;
    setExpanded((previous) =>
      [...previous].every((id) => ids.has(id))
        ? previous
        : new Set([...previous].filter((id) => ids.has(id))),
    );
    setFocused((previous) =>
      previous !== null && !current.has(previous) ? null : previous,
    );
    if (!reading) virtualizer.scrollToOffset(0);
  }, [buckets, ids, reading, virtualizer]);
  const items = virtualizer.getVirtualItems();
  const paddingBottom = Math.max(
    0,
    virtualizer.getTotalSize() -
      ((items.at(-1)?.end ?? scrollMargin) - scrollMargin),
  );
  const anchorTime = anchor ? presentLogEntry(anchor).timestamp : null;
  if (devices.length < 2)
    return (
      <div className="h-full overflow-auto overscroll-contain">
        <EmptyState
          icon={<Columns2 size={24} />}
          title={devices.length ? "再选择一台设备" : "选择要对比的设备"}
          description={`选择 2–${maximumComparedDevices} 台设备后，上报会按接收时间并排显示。`}
        />
      </div>
    );
  if (!rows.length)
    return (
      <div className="h-full overflow-auto overscroll-contain">
        <EmptyState
          icon={<Activity size={24} />}
          title="所选设备暂无匹配上报"
          description="可以调整已加载记录搜索、时间范围，或查看其他设备。"
        />
      </div>
    );
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label="设备日志时间对比"
    >
      {anchor && (
        <output className="flex shrink-0 items-center justify-between gap-2.5 py-2.5 px-4 bg-linen text-ink text-[11px] max-[901px]:items-start">
          <span>
            时间基准：{anchor.device_name} ·{" "}
            {presentLogEntry(anchor).preciseTime} · {anchor.id}
            {!ids.has(anchor.id) ? "（当前列表外）" : ""}
          </span>
          <button
            className="border-0 bg-transparent text-inherit whitespace-nowrap cursor-pointer underline"
            onClick={() => onAnchor(null)}
          >
            清除基准
          </button>
        </output>
      )}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable] [overflow-anchor:none] focus-visible:outline-1 focus-visible:outline-ink/50 focus-visible:-outline-offset-2"
        tabIndex={0}
        aria-label="横向滚动查看全部对比设备"
        onScroll={(event) => {
          const next = event.currentTarget.scrollTop > 1;
          if (next !== reading) onReadingChange(next);
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
          if (
            scrollTop > 1 &&
            scrollHeight - scrollTop - clientHeight <= clientHeight
          )
            onLoadOlder();
        }}
      >
        <table
          className="w-full table-fixed border-separate border-spacing-0 text-[11px]"
          style={{ minWidth: 88 + devices.length * 210 }}
          aria-rowcount={buckets.length + 1}
        >
          <caption
            ref={caption}
            className="caption-top text-left py-3 px-6 text-muted leading-[1.7]"
          >
            同秒归组，不代表同时触发。点“设为基准”查看接收时间差。
          </caption>
          <thead ref={heading}>
            <tr>
              <th
                className="sticky top-0 left-0 z-3 w-22 bg-white p-2.5 text-left align-top font-normal tabular-nums"
                scope="col"
              >
                接收时间
              </th>
              {devices.map((device, index) => {
                const count = counts.get(device.id) ?? 0;
                return (
                  <th
                    scope="col"
                    key={device.id}
                    className={twMerge(
                      `sticky top-0 z-2 border-t-0 bg-white p-2.5 text-left align-top font-normal ${compareColors[index]}`,
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-[12px] wrap-anywhere">
                      <i className="w-1.5 h-1.5 rounded-full bg-[var(--compare-color)] shrink-0" />
                      <strong>{device.name}</strong>
                    </div>
                    <span
                      className="mt-1.25 block text-[11px] text-muted"
                      title={device.id}
                    >
                      {device.room} · 已加载 {count} 条
                    </span>
                    {!count && (
                      <small className="mt-1.25 block text-[11px] text-muted">
                        已加载记录中无匹配项
                      </small>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={body}>
            {items.map((item, index) => {
              const [second, entries] = buckets[item.index]!;
              const padding = Math.max(
                0,
                item.start - (items[index - 1]?.end ?? scrollMargin),
              );
              return (
                <Fragment key={second}>
                  {padding > 0 ? (
                    <tr aria-hidden="true">
                      <td
                        aria-hidden="true"
                        colSpan={devices.length + 1}
                        className="p-0"
                        style={{ height: padding }}
                      />
                    </tr>
                  ) : null}
                  <tr
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    aria-rowindex={item.index + 2}
                    onFocusCapture={() => setFocused(second)}
                    onBlurCapture={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget))
                        setFocused(null);
                    }}
                  >
                    <th
                      className="sticky left-0 z-1 w-22 border-b-10 border-transparent bg-clip-padding bg-white p-2.5 text-left align-top font-normal tabular-nums"
                      scope="row"
                    >
                      <time>{time(second * 1000)}</time>
                    </th>
                    {devices.map((device) => (
                      <td
                        className="p-2.5 align-top text-left border-b-10 border-transparent bg-clip-padding bg-white"
                        key={device.id}
                      >
                        {entries.get(device.id)?.map((row) => {
                          const presentation = presentLogEntry(row);
                          const delta =
                            anchorTime !== null
                              ? presentation.timestamp - anchorTime
                              : null;
                          return (
                            <article
                              key={row.id}
                              className={twMerge(
                                `px-2 py-3 wrap-anywhere not-first:mt-6 not-first:pt-4 [&_>_small]:block [&_>_small]:text-muted [&_>_small]:text-[11px] [&_>_small]:mt-1.25 [&_footer_button]:min-h-6 [&_footer_button]:text-[11px] [&_footer_button]:text-muted [&_footer_button]:border-0 [&_footer_button]:bg-transparent [&_footer_button]:cursor-pointer [&_footer_button]:py-0.75 [&_footer_button]:px-0 [&_footer_button:hover]:text-ink ${anchor?.id === row.id ? "rounded-lg bg-linen" : ""}`,
                              )}
                            >
                              <header className="flex flex-wrap gap-y-1 gap-x-2 items-center mb-2 text-[11px] text-muted tabular-nums">
                                <time>{presentation.preciseTime}</time>
                                {delta !== null && (
                                  <span className="text-ink font-semibold">
                                    {delta === 0
                                      ? "0 ms"
                                      : `${delta > 0 ? "+" : ""}${delta} ms`}
                                  </span>
                                )}
                              </header>
                              <strong className="text-[15px] leading-6 font-medium">
                                {row.description || row.property}
                              </strong>

                              <div className="flex gap-2.5 items-center mt-2 text-xs [&_svg]:shrink-0 [&_svg]:text-muted">
                                <code className="text-sm leading-7 wrap-anywhere min-w-0">
                                  {row.displayValue}
                                </code>
                              </div>
                              <footer className="flex justify-between items-center flex-wrap gap-1.5 mt-2.5">
                                <button
                                  aria-pressed={anchor?.id === row.id}
                                  onClick={() =>
                                    onAnchor(anchor?.id === row.id ? null : row)
                                  }
                                  aria-label={`将记录 ${row.id} 设为时间基准`}
                                >
                                  {anchor?.id === row.id
                                    ? "取消基准"
                                    : "设为基准"}
                                </button>
                              </footer>
                              <details
                                open={expanded.has(row.id)}
                                onToggle={(event) => {
                                  const open = event.currentTarget.open;
                                  setExpanded((previous) => {
                                    if (previous.has(row.id) === open)
                                      return previous;
                                    const next = new Set(previous);
                                    if (open) next.add(row.id);
                                    else next.delete(row.id);
                                    return next;
                                  });
                                }}
                              >
                                <summary className="min-h-6 text-[11px] mt-2.5 text-muted cursor-pointer">
                                  查看详情
                                </summary>
                                {expanded.has(row.id) ? (
                                  <LogEventDetail row={row} comparison />
                                ) : null}
                              </details>
                            </article>
                          );
                        })}
                      </td>
                    ))}
                  </tr>
                </Fragment>
              );
            })}
            {paddingBottom > 0 ? (
              <tr aria-hidden="true">
                <td
                  aria-hidden="true"
                  colSpan={devices.length + 1}
                  className="p-0"
                  style={{ height: paddingBottom }}
                />
              </tr>
            ) : null}
          </tbody>
        </table>
        {loadingOlder ? (
          <output className="block py-3 text-center text-xs text-muted">
            正在读取更早记录…
          </output>
        ) : null}
      </div>
    </section>
  );
});

/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */
