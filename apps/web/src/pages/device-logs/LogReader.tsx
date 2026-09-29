import {
  logViews,
  selectLogEntries,
  filterLogEntries,
  latestLogValues,
} from "./log-data";
import { twMerge } from "tailwind-merge";
import { memo, useMemo, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { Activity, Columns2, Search, X } from "lucide-react";
import type { DeviceLogSnapshot } from "@home-agent/api/device-logs";
import { EmptyState } from "../../components/EmptyState";
import { TextReveal } from "../../components/TextReveal";
import { Button } from "../../components/Button";
import { Disclosure } from "../../components/Disclosure";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Switch } from "../../components/Switch";
import { expand } from "../../utils/motion";
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
  runId,
  hasRun,
  loaded,
  capturing,
  paused,
  onResume,
  onToggleComparison,
}: {
  entries: DeviceLogSnapshot["entries"];
  selection: ReturnType<typeof useDeviceSelection>;
  comparison: ReturnType<typeof useLogComparison>;
  runId: string | undefined;
  hasRun: boolean;
  loaded: boolean;
  capturing: boolean;
  paused: boolean;
  onResume: () => void;
  onToggleComparison: () => void;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] =
    useState<(typeof logViews)[number]["value"]>("signals");
  const [showRepeated, setShowRepeated] = useState(false);
  const {
    deviceId,
    setDeviceId,
    filters,
    visibleIds,
    selectedDevice,
    selectionLabel,
    filtering,
    clearFilters,
  } = selection;
  const { query: deviceQuery, room, category, reportFilter } = filters;
  const { comparing, compareIds, compareDevices } = comparison;
  const selectedEntries = useMemo(
    () =>
      selectLogEntries(entries, {
        comparing,
        compareIds,
        deviceId,
        filtering,
        visibleIds,
      }),
    [entries, comparing, compareIds, deviceId, filtering, visibleIds],
  );
  const search = query.trim().toLowerCase();
  const rows = useMemo(
    () => filterLogEntries(selectedEntries, { view, showRepeated, search }),
    [selectedEntries, view, showRepeated, search],
  );
  const latest = useMemo(
    () => (deviceId && !comparing ? latestLogValues(selectedEntries) : []),
    [selectedEntries, deviceId, comparing],
  );
  return (
    <div className="min-w-0 self-start rounded-2xl bg-surface p-3 [&_>_.empty-state]:mx-1 [&_>_.empty-state]:mb-2">
      <div className="flex items-center justify-start gap-y-1.5 gap-x-3 flex-wrap pt-2.5 px-4 pb-2 max-[901px]:py-2.5">
        <TextReveal
          changeKey={comparing ? "comparing" : (deviceId ?? "all")}
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
        >
          <h3 className="m-0 text-[17px] font-semibold">
            {comparing ? `设备对比 · ${compareIds.length} 台` : selectionLabel}
          </h3>
          {!comparing && selectedDevice && (
            <span className="text-[12px] text-muted wrap-anywhere">
              {selectedDevice.room}
            </span>
          )}
          <span
            className="text-[12px] text-muted wrap-anywhere"
            title={
              comparing
                ? "按接收时间对齐，同秒归组；页面保留最近 500 条"
                : "最新事件在前；页面保留最近 500 条"
            }
          >
            {rows.length} 条记录
            {paused ? " · 显示已冻结，后台继续采集" : ""}
          </span>
        </TextReveal>
        <Button
          variant="ghost"
          className="ml-auto min-h-8 py-1 px-2 text-[12px]"
          icon={comparing ? <X size={14} /> : <Columns2 size={14} />}
          onClick={onToggleComparison}
          disabled={!hasRun}
        >
          {comparing ? "退出对比" : "设备对比"}
        </Button>
      </div>
      <ComparisonSelection comparison={comparison} />
      <AnimatePresence initial={false}>
        {selectedDevice && !comparing && latest.length > 0 && (
          <m.section
            key="values"
            className="overflow-hidden"
            aria-label="最近上报值"
            {...expand}
          >
            <Disclosure
              className="px-4 pt-0 pb-1 max-[901px]:py-1"
              title={`最近上报值 · ${latest.length} 项`}
            >
              <p className="mb-3">取自最近 500 条记录，非实时状态查询。</p>
              <div className="grid grid-cols-[repeat(auto-fit,_minmax(160px,_1fr))] gap-2.5 max-h-37.5 overflow-auto [scrollbar-gutter:stable]">
                {latest.map((row) => (
                  <div
                    className="min-w-0 border-b border-line px-0 py-3 relative"
                    key={`${row.device_id}:${row.kind}:${row.property}`}
                  >
                    <span className="block text-[11px] text-muted wrap-anywhere">
                      {row.description || row.property || "在线状态"}
                    </span>
                    <code className="block text-[16px] my-1.5 mx-0 wrap-anywhere">
                      {row.value}
                    </code>
                    <small className="block text-[11px] text-muted wrap-anywhere">
                      {presentLogEntry(row).time} · {row.property || "在线状态"}
                    </small>
                  </div>
                ))}
              </div>
            </Disclosure>
          </m.section>
        )}
      </AnimatePresence>
      <div className="flex items-center justify-between gap-y-2 gap-x-5 pt-2 px-4 pb-3 flex-wrap [&_>_[role='group']]:shrink-0 max-[901px]:pl-4 max-[901px]:pr-4 max-[901px]:gap-x-4">
        <SegmentedControl
          label="日志视图"
          variant="underline"
          value={view}
          onValueChange={setView}
          options={logViews}
        />
        <div className="flex items-center justify-start gap-y-2 gap-x-4 p-0 ml-auto max-w-full flex-wrap min-w-0 max-[901px]:w-full max-[901px]:ml-0">
          <div
            className={twMerge(
              `m-0 flex min-w-0 flex-[1_1_220px] w-70 max-w-80 items-center gap-2 rounded-lg border border-transparent bg-white px-2.5 text-muted max-[901px]:w-auto max-[901px]:max-w-none focus-within:outline-1 focus-within:outline-offset-0 focus-within:outline-accent/50 ${query.trim() ? "border-ink/24" : ""}`,
            )}
          >
            <Search size={14} className="shrink-0" aria-hidden="true" />
            <input
              className="w-full min-w-0 border-0 bg-transparent px-0 py-1.75 text-[12px] focus-visible:outline-none focus-visible:shadow-none"
              aria-label="搜索日志"
              placeholder={
                view === "signals" ? "搜索属性、描述或值" : "搜索连接与订阅记录"
              }
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className="inline-flex items-center justify-center shrink-0 w-6 h-6 rounded-md text-muted cursor-pointer hover:bg-surface hover:text-ink"
                aria-label="清除日志搜索"
                title="清除搜索"
                onClick={() => setQuery("")}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          {view === "signals" && (
            <Switch
              className="whitespace-nowrap text-muted [&:has([data-state='checked'])]:text-ink"
              checked={showRepeated}
              onCheckedChange={setShowRepeated}
              title="显示数值未变化的重复上报"
            >
              显示重复上报
            </Switch>
          )}
        </div>
      </div>
      {!loaded ? (
        <LogEventsSkeleton />
      ) : comparing ? (
        <LogComparison
          devices={compareDevices}
          rows={rows}
          anchor={comparison.anchor}
          onAnchor={comparison.setAnchor}
        />
      ) : (
        <LogEvents
          key={JSON.stringify([
            runId,
            view,
            query,
            showRepeated,
            deviceId,
            deviceQuery,
            room,
            category,
            reportFilter,
          ])}
          rows={rows}
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
                !hasRun
                  ? "还未开始采集"
                  : query.trim() || filtering
                    ? "没有匹配的记录"
                    : paused
                      ? "显示已暂停"
                      : view === "connection"
                        ? "暂无连接与订阅记录"
                        : capturing
                          ? "等待设备上报"
                          : "本次采集没有匹配上报"
              }
              description={
                !hasRun
                  ? "从页头开始采集，设备上报会显示在这里。"
                  : query.trim() || filtering
                    ? "当前搜索或筛选条件下没有记录，可以清除条件后查看。"
                    : paused
                      ? "后台仍在采集。恢复实时更新后，可以查看新收到的上报。"
                      : view === "connection"
                        ? "这里记录连接和订阅的变化，全局记录可在「全部设备」中查看。"
                        : capturing
                          ? `${selectedDevice?.name ?? "设备"}的上报会自动出现在这里。暂未上报不代表离线。`
                          : "采集已结束。可以查看其他设备，或从页头开始新一轮采集。"
              }
            >
              {query.trim() ? (
                <Button onClick={() => setQuery("")}>清除事件搜索</Button>
              ) : filtering ? (
                <Button onClick={clearFilters}>清除设备筛选</Button>
              ) : paused ? (
                <Button onClick={onResume}>恢复实时更新</Button>
              ) : deviceId ? (
                <Button onClick={() => setDeviceId(null)}>查看全部设备</Button>
              ) : !showRepeated &&
                selectedEntries.some((row) => row.change === "same") ? (
                <Button onClick={() => setShowRepeated(true)}>
                  显示重复上报
                </Button>
              ) : null}
            </EmptyState>
          }
        />
      )}
    </div>
  );
});
