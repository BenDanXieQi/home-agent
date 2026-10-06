import { SearchField } from "../../components/SearchField";
import { logViews, filterLogEntries, latestLogValues } from "./log-data";
import { memo, useMemo, useState } from "react";
import { Activity, Columns2, Search, X } from "lucide-react";
import type { LogEntry } from "../../modules/device-history/presentation";
import { EmptyState } from "../../components/EmptyState";
import { Button } from "../../components/Button";
import { Disclosure } from "../../components/Disclosure";
import { SegmentedControl } from "../../components/SegmentedControl";
import { LogEvents } from "./LogEvents";
import { ComparisonSelection, LogComparison } from "./LogComparison";
import { LogEventsSkeleton } from "./skeletons";
import { presentLogEntry } from "./presentation";
import type { useDeviceSelection } from "./use-device-selection";
import type { useLogComparison } from "./use-log-comparison";

export const LogReader = memo(function LogReader({
  entries,
  selection,
  comparison,
  queryKey,
  loaded,
  updating,
  paused,
  view,
  onViewChange,
  onResume,
  onToggleComparison,
  onLoadOlder,
  loadingOlder,
}: {
  entries: LogEntry[];
  selection: ReturnType<typeof useDeviceSelection>;
  comparison: ReturnType<typeof useLogComparison>;
  queryKey: string;
  loaded: boolean;
  updating: boolean;
  paused: boolean;
  view: (typeof logViews)[number]["value"];
  onViewChange: (view: (typeof logViews)[number]["value"]) => void;
  onResume: () => void;
  onToggleComparison: () => void;
  onLoadOlder: () => void;
  loadingOlder: boolean;
}) {
  const [query, setQuery] = useState("");
  const { deviceId, selectedDevice, selectionLabel, filtering, clearFilters } =
    selection;
  const { comparing, compareIds, compareDevices } = comparison;
  const search = query.trim().toLowerCase();
  const rows = useMemo(
    () => filterLogEntries(entries, { view: "all", search }),
    [entries, search],
  );
  const readingKey = JSON.stringify([queryKey, query, comparing]);
  const [savedReading, setReading] = useState<{
    key: string;
    rows: LogEntry[];
  } | null>(null);
  const reading = useMemo(() => {
    if (savedReading?.key !== readingKey) return null;
    const frozen = savedReading.rows;
    const last = frozen.at(-1);
    const boundary = last ? rows.findIndex((row) => row.id === last.id) : -1;
    if (boundary < 0 || boundary === rows.length - 1) return frozen;
    const retained = new Set(frozen.map((row) => row.id));
    const older = rows
      .slice(boundary + 1)
      .filter((row) => !retained.has(row.id));
    return older.length ? [...frozen, ...older] : frozen;
  }, [savedReading, readingKey, rows]);
  if (savedReading && savedReading.key !== readingKey) setReading(null);
  const changeReading = (value: boolean) => {
    setReading(value ? { key: readingKey, rows: reading ?? rows } : null);
  };
  const latest = useMemo(
    () => (deviceId && !comparing ? latestLogValues(entries) : []),
    [entries, deviceId, comparing],
  );
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-2xl bg-surface p-3">
      <div className="min-h-0 shrink overflow-auto overscroll-contain">
        <div className="flex items-center gap-y-1.5 gap-x-3 flex-wrap pt-2.5 px-4 pb-2 max-[901px]:py-2.5">
          <h2 className="m-0 text-[17px] font-semibold">
            {comparing ? `设备对比 · ${compareIds.length} 台` : selectionLabel}
          </h2>
          {selectedDevice && !comparing ? (
            <span className="text-xs text-muted">{selectedDevice.room}</span>
          ) : null}
          <span
            className="text-xs text-muted"
            title="最新记录在前；数量仅为当前已加载记录"
          >
            {loaded
              ? `${(reading ?? rows).length} 条已加载记录`
              : "正在读取记录…"}
            {paused ? " · 固定时间范围" : reading ? " · 阅读已暂停" : ""}
          </span>
          {reading && comparing ? (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                changeReading(false);
                comparison.clearAnchor();
              }}
            >
              {paused ? "回到顶部" : "返回最新记录"}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            className="ml-auto min-h-8 py-1 px-2 text-xs"
            icon={comparing ? <X size={14} /> : <Columns2 size={14} />}
            onClick={onToggleComparison}
          >
            {comparing ? "退出对比" : "设备对比"}
          </Button>
        </div>
        <ComparisonSelection comparison={comparison} />
        {latest.length ? (
          <Disclosure
            className="px-4 pt-0 pb-1"
            title={`已加载最近值 · ${latest.length} 项`}
          >
            <p className="mb-3">
              取自当前已加载记录，时间范围之外的报告未包含在内。
            </p>
            <div className="grid grid-cols-[repeat(auto-fit,_minmax(160px,_1fr))] gap-2.5 max-h-37.5 overflow-auto">
              {latest.map((row) => (
                <div
                  className="min-w-0 border-b border-line py-3"
                  key={`${row.device_id}:${row.kind}:${row.property}`}
                >
                  <span className="block text-[11px] text-muted wrap-anywhere">
                    {row.description || row.property}
                  </span>
                  <code className="block text-base my-1.5 wrap-anywhere">
                    {row.displayValue}
                  </code>
                  <small className="block text-[11px] text-muted">
                    {presentLogEntry(row).time} · {row.property}
                  </small>
                </div>
              ))}
            </div>
          </Disclosure>
        ) : null}
        <div className="flex items-center justify-between gap-y-2 gap-x-5 px-4 pt-2 pb-3 flex-wrap">
          <SegmentedControl
            label="记录类型"
            variant="underline"
            value={view}
            onValueChange={onViewChange}
            onReselect={() => onViewChange(view)}
            options={logViews}
          />
          <div className="flex gap-4 items-center flex-wrap ml-auto min-w-0">
            <SearchField
              label="搜索已加载日志"
              placeholder="搜索已加载属性、描述或值"
              value={query}
              onChange={setQuery}
              className="w-64"
            />
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-[1_0_8rem]" aria-busy={updating || !loaded}>
        {!loaded ? (
          <LogEventsSkeleton />
        ) : comparing ? (
          <LogComparison
            key={readingKey}
            devices={compareDevices}
            rows={reading ?? rows}
            reading={Boolean(reading)}
            onReadingChange={changeReading}
            onLoadOlder={onLoadOlder}
            loadingOlder={loadingOlder}
            anchor={comparison.anchor}
            onAnchor={comparison.setAnchor}
          />
        ) : (
          <LogEvents
            key={JSON.stringify([queryKey, query])}
            rows={rows}
            reading={reading}
            onReadingChange={changeReading}
            onLoadOlder={onLoadOlder}
            loadingOlder={loadingOlder}
            paused={paused}
            showDevice={!deviceId}
            empty={
              <EmptyState
                icon={
                  query.trim() || filtering ? (
                    <Search size={24} />
                  ) : (
                    <Activity size={24} />
                  )
                }
                title={
                  query.trim() || filtering
                    ? "没有匹配的记录"
                    : "这个时间范围暂无记录"
                }
                description={
                  query.trim()
                    ? "搜索只检查已加载记录，可清除搜索后继续向下滚动。"
                    : "可调整时间范围或设备筛选。未收到报告不代表设备离线。"
                }
              >
                {query.trim() ? (
                  <Button onClick={() => setQuery("")}>清除日志搜索</Button>
                ) : filtering ? (
                  <Button onClick={clearFilters}>清除设备筛选</Button>
                ) : paused ? (
                  <Button onClick={onResume}>查看最新记录</Button>
                ) : null}
              </EmptyState>
            }
          />
        )}
      </div>
    </div>
  );
});
