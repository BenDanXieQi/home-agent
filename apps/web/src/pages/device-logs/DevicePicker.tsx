import { maximumComparedDevices } from "./log-data";
import { twMerge } from "tailwind-merge";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useState,
} from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, m } from "motion/react";
import { Check, ChevronDown, Search, RotateCcw } from "lucide-react";
import { Button } from "../../components/Button";
import { Select } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { SelectionIndicator } from "../../components/SelectionIndicator";
import { VirtualRow } from "../../components/VirtualRow";
import { usePreviousKeys } from "../../utils/use-previous-keys";
import { contentSwap, iconSwap } from "../../utils/motion";
import { LogDevicesSkeleton } from "./skeletons";
import type { useDeviceSelection } from "./use-device-selection";
import type { useLogComparison } from "./use-log-comparison";

const MotionCheck = m.create(Check);

export const DevicePicker = memo(function DevicePicker({
  selection: deviceSelection,
  comparison,
  loaded,
  hasRun,
  open: devicesOpen,
  onOpenChange,
}: {
  selection: ReturnType<typeof useDeviceSelection>;
  comparison: ReturnType<typeof useLogComparison>;
  loaded: boolean;
  hasRun: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    devices,
    allDevices,
    deviceId,
    setDeviceId,
    filters,
    updateFilters,
    filtering,
    clearFilters,
    roomOptions,
    categoryOptions,
  } = deviceSelection;
  const { query: deviceQuery, room, category, reportFilter } = filters;
  const { comparing, compareIds, toggleComparison } = comparison;
  // List items animate only when the listed set changes, never when content above moves.
  const membership = useMemo(
    () => `${comparing}:${devices.map((device) => device.id).join()}`,
    [comparing, devices],
  );
  const selectionId = useId();
  const deviceList = useRef<HTMLDivElement>(null);
  const deviceRows = useRef<HTMLDivElement>(null);
  const [deviceRowsOffset, setDeviceRowsOffset] = useState(0);
  const [focusedDevice, setFocusedDevice] = useState<string | null>(null);
  const deviceKeys = useMemo(
    () => new Set(devices.map((device) => device.id)),
    [devices],
  );
  const previousDeviceKeys = usePreviousKeys(deviceKeys);
  useLayoutEffect(() => {
    const element = deviceRows.current;
    const scroller = deviceList.current;
    if (!element || !scroller) return undefined;
    // The positioned scroll container is the rows' direct offsetParent.
    const measure = () => setDeviceRowsOffset(element.offsetTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    if (element.previousElementSibling)
      observer.observe(element.previousElementSibling);
    return () => observer.disconnect();
  }, [comparing, loaded, devicesOpen]);
  const retainedDevices = useMemo(
    () =>
      devices.flatMap((device, index) =>
        device.id === deviceId || device.id === focusedDevice ? [index] : [],
      ),
    [devices, deviceId, focusedDevice],
  );
  // oxlint-disable-next-line react/incompatible-library -- Read live virtual measurements directly rather than compiler-memoizing them.
  const deviceVirtualizer = useVirtualizer({
    count: devices.length,
    getScrollElement: () => deviceList.current,
    estimateSize: () => 71,
    scrollMargin: deviceRowsOffset,
    overscan: 4,
    getItemKey: useCallback((index: number) => devices[index]!.id, [devices]),
    rangeExtractor: useCallback(
      (range: Parameters<typeof defaultRangeExtractor>[0]) =>
        [
          ...new Set([...defaultRangeExtractor(range), ...retainedDevices]),
        ].toSorted((a, b) => a - b),
      [retainedDevices],
    ),
  });
  const virtualDevices = deviceVirtualizer.getVirtualItems();
  const measureDevice = useCallback(
    (index: number, height: number) =>
      deviceVirtualizer.resizeItem(index, height),
    [deviceVirtualizer],
  );

  return (
    <aside
      id="log-devices"
      className="flex min-h-0 min-w-0 flex-col bg-paper p-3 min-[901px]:h-full"
      data-open={devicesOpen}
      aria-label="设备列表"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 text-[12px] mb-2.5 max-[901px]:flex-wrap py-0 px-2.5 max-[901px]:mb-0">
        <strong>设备</strong>
        <button
          type="button"
          className="ml-auto inline-flex min-h-8 items-center gap-2 text-xs min-[901px]:hidden"
          aria-expanded={devicesOpen}
          aria-controls="log-device-picker"
          onClick={() => onOpenChange(!devicesOpen)}
        >
          {devicesOpen ? "收起列表" : "选择设备"}
          <ChevronDown
            size={14}
            className={`shrink-0 ${devicesOpen ? "rotate-180" : ""}`}
          />
        </button>
        {loaded ? (
          <span
            className="text-muted text-[11px] font-normal"
            aria-live="polite"
            aria-atomic="true"
          >
            {devices.length} / {allDevices.length} 台
          </span>
        ) : (
          <Skeleton className="h-3 w-14" />
        )}
      </div>
      <div
        id="log-device-picker"
        className={`flex min-h-0 flex-1 flex-col ${devicesOpen ? "max-[901px]:pt-3" : "max-[901px]:hidden"}`}
      >
        <div className="min-h-0 shrink overflow-auto overscroll-contain">
          <label className="m-0 flex min-w-0 items-center gap-2 rounded-lg bg-linen/60 px-2.5 text-muted focus-within:outline-1 focus-within:outline-offset-0 focus-within:outline-accent/50">
            <Search size={15} className="shrink-0" aria-hidden="true" />
            <input
              className="w-full min-w-0 border-0 bg-transparent px-0 py-[9px] text-[13px] focus-visible:outline-none focus-visible:shadow-none"
              aria-label="搜索设备"
              placeholder="设备、房间或 ID"
              value={deviceQuery}
              onChange={(event) => {
                updateFilters({ query: event.target.value });
              }}
            />
          </label>
          <fieldset
            className="shrink-0 min-w-0 mt-2 mx-0 mb-0 grid grid-cols-2 gap-y-1 gap-x-2 p-0 border-0"
            aria-label="筛选设备"
          >
            <Select
              label="房间"
              className={twMerge(
                `h-8 px-2.5 py-0 bg-transparent text-[12px] font-normal text-muted enabled:hover:bg-surface data-[state=open]:bg-surface pointer-coarse:min-h-11 ${room ? "border-ink/24 text-ink font-medium" : ""}`,
              )}
              value={room}
              onValueChange={(value) => {
                updateFilters({ room: value });
              }}
              options={roomOptions}
            />
            <Select
              label="设备类型"
              searchable
              className={twMerge(
                `h-8 px-2.5 py-0 bg-transparent text-[12px] font-normal text-muted enabled:hover:bg-surface data-[state=open]:bg-surface pointer-coarse:min-h-11 ${category ? "border-ink/24 text-ink font-medium" : ""}`,
              )}
              value={category}
              onValueChange={(value) => {
                updateFilters({ category: value });
              }}
              options={categoryOptions}
            />
            <div className="col-span-full grid grid-cols-2 items-center gap-2 min-w-0">
              <Select
                label="上报情况"
                className={twMerge(
                  `h-8 px-2.5 py-0 bg-transparent text-[12px] font-normal text-muted enabled:hover:bg-surface data-[state=open]:bg-surface pointer-coarse:min-h-11 ${reportFilter ? "border-ink/24 text-ink font-medium" : ""}`,
                )}
                value={reportFilter}
                onValueChange={(value) => {
                  updateFilters({ reportFilter: value });
                }}
                options={[
                  { value: "", label: "上报不限" },
                  { value: "reported", label: "有上报" },
                  { value: "silent", label: "暂未上报" },
                ]}
              />
              <Button
                type="button"
                variant="ghost"
                className="justify-self-end w-auto h-8 min-h-8 py-0 px-2 bg-transparent text-ink text-[12px] enabled:hover:bg-surface enabled:hover:text-ink disabled:text-muted disabled:opacity-40 disabled:cursor-default pointer-coarse:min-h-11"
                icon={<RotateCcw size={14} aria-hidden="true" />}
                aria-label="重置筛选"
                title="重置筛选"
                onClick={clearFilters}
                disabled={!filtering}
              >
                重置
              </Button>
            </div>
          </fieldset>
        </div>
        <m.div
          ref={deviceList}
          className="group/device-list relative grid min-h-0 flex-[1_0_4rem] content-start gap-0.75 mt-2.5 overflow-auto overscroll-contain [scrollbar-gutter:stable] isolate"
          data-comparing={comparing}
          layoutScroll
        >
          <AnimatePresence initial={false} mode="popLayout">
            {comparing ? (
              <m.output
                key="compare-note"
                layout="position"
                layoutDependency={membership}
                className="block py-1.5 px-2 text-[11px] text-muted"
                {...contentSwap}
              >
                已选 {compareIds.length} / 4 台 ·{" "}
                {compareIds.length < 2 ? "至少选择 2 台" : "点击设备可取消选择"}
              </m.output>
            ) : null}
            {!loaded ? <LogDevicesSkeleton /> : null}
          </AnimatePresence>
          <div
            ref={deviceRows}
            className="relative"
            style={{ height: deviceVirtualizer.getTotalSize() }}
            onFocusCapture={(event) =>
              setFocusedDevice(
                event.target.closest<HTMLElement>("[data-virtual-row]")?.dataset
                  .virtualRow ?? null,
              )
            }
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setFocusedDevice(null);
            }}
          >
            <AnimatePresence initial={false} custom={deviceKeys}>
              {virtualDevices.map((item) => {
                const device = devices[item.index]!;
                return (
                  <VirtualRow
                    key={device.id}
                    id={device.id}
                    index={item.index}
                    top={item.start - deviceRowsOffset}
                    gap={item.index === devices.length - 1 ? 0 : 3}
                    membership={membership}
                    entering={!previousDeviceKeys.has(device.id)}
                    onSize={measureDevice}
                  >
                    <button
                      className="relative isolate flex gap-2.5 items-center w-full text-left p-2.5 border border-transparent rounded-lg bg-transparent cursor-pointer text-ink [&_svg]:shrink-0 [&_svg]:text-muted aria-[pressed=false]:enabled:hover:bg-surface group-data-[comparing=true]/device-list:aria-pressed:bg-sidebar aria-pressed:[&_small]:text-ink aria-pressed:[&_svg]:text-inherit disabled:opacity-45 disabled:cursor-not-allowed"
                      aria-pressed={
                        comparing
                          ? compareIds.includes(device.id)
                          : deviceId === device.id
                      }
                      disabled={
                        comparing &&
                        compareIds.length >= maximumComparedDevices &&
                        !compareIds.includes(device.id)
                      }
                      title={
                        comparing &&
                        compareIds.length >= maximumComparedDevices &&
                        !compareIds.includes(device.id)
                          ? `最多对比 ${maximumComparedDevices} 台设备，请先取消一台`
                          : !comparing && deviceId === device.id
                            ? "再次点击取消选择，查看当前列表的全部上报"
                            : `${device.id} · ${device.properties + device.online} 条上报`
                      }
                      onClick={() => {
                        if (comparing) toggleComparison(device.id);
                        else {
                          setDeviceId(
                            deviceId === device.id ? null : device.id,
                          );
                          onOpenChange(false);
                        }
                      }}
                    >
                      {!comparing && deviceId === device.id ? (
                        <SelectionIndicator
                          layoutId={selectionId}
                          className="inset-0 rounded-lg bg-sidebar"
                        />
                      ) : null}
                      <AnimatePresence mode="popLayout" initial={false}>
                        {comparing ? (
                          <m.span
                            key="checkbox"
                            className="grid [place-items:center] flex-[0_0_16px] w-4 h-4 border border-line rounded text-ink bg-white"
                            aria-hidden="true"
                            {...iconSwap}
                          >
                            <AnimatePresence initial={false}>
                              {compareIds.includes(device.id) && (
                                <MotionCheck size={12} {...iconSwap} />
                              )}
                            </AnimatePresence>
                          </m.span>
                        ) : null}
                      </AnimatePresence>
                      <span className="min-w-0">
                        <strong className="block text-[13px] leading-5 font-medium wrap-anywhere">
                          {device.name}
                        </strong>
                        <small className="block text-[11px] mt-0.5 text-muted">
                          {device.room}
                        </small>
                      </span>
                      {!comparing && deviceId === device.id ? (
                        <Check
                          size={14}
                          className="ml-auto"
                          aria-hidden="true"
                        />
                      ) : null}
                    </button>
                  </VirtualRow>
                );
              })}
            </AnimatePresence>
          </div>
          <AnimatePresence initial={false}>
            {loaded && !devices.length && (
              <m.p
                key="empty"
                className="text-muted text-[11px] leading-[1.8] py-2 px-1.5"
                {...contentSwap}
              >
                {hasRun
                  ? "没有匹配的设备"
                  : "开始采集后，在这里选择要调试的设备。"}
              </m.p>
            )}
          </AnimatePresence>
        </m.div>
        <p className="shrink-0 text-muted text-[11px] leading-[1.8] py-2 px-1.5">
          {comparing
            ? "左侧筛选用于找设备，不会移除已选设备。"
            : "筛选只影响显示，不影响采集。"}
        </p>
      </div>
    </aside>
  );
});
