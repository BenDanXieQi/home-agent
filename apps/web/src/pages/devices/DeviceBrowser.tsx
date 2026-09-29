import { DeviceList, DeviceRow } from "./DeviceList";
import { twMerge } from "tailwind-merge";
import { EmptyState } from "../../components/EmptyState";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  defaultRangeExtractor,
  useWindowVirtualizer,
} from "@tanstack/react-virtual";
import { VirtualRow } from "../../components/VirtualRow";
import { usePreviousKeys } from "../../utils/use-previous-keys";
import { useAtom, useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import {
  Search,
  Video,
  Box,
  ArrowUpRight,
  SlidersHorizontal,
} from "lucide-react";
import { m, AnimatePresence } from "motion/react";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Button } from "../../components/Button";
import { Select } from "../../components/Select";
import { expand } from "../../utils/motion";
import { DeviceRowsSkeleton } from "./skeletons";
import {
  deviceSearchAtom,
  deviceFilterAtom,
  deviceFiltersAtom,
  deviceFilterOptionsAtom,
  filteredDevicesAtom,
} from "./filters";
import type { deviceInventoryAtom } from "../../modules/devices/state";

const availabilityOptions = [
  { value: "all", label: "全部" },
  { value: "online", label: "在线" },
  { value: "offline", label: "离线" },
  { value: "unknown", label: "未知" },
];
const capabilityOptions = [
  { value: "readable", label: "可读取" },
  { value: "writeable", label: "可写入" },
  { value: "notify", label: "属性通知" },
  { value: "action", label: "设备动作" },
  { value: "event", label: "设备事件" },
];
export const DeviceBrowser = memo(function DeviceBrowser({
  status,
  reliable,
  layoutRef,
}: {
  status: NonNullable<ReturnType<typeof deviceInventoryAtom.read>>["status"];
  reliable: boolean;
  layoutRef: RefObject<HTMLDivElement | null>;
}) {
  const [search, setSearch] = useAtom(deviceSearchAtom);
  const [filter, setFilter] = useAtom(deviceFilterAtom);
  const [filters, setFilters] = useAtom(deviceFiltersAtom);
  const activeRefinements = Object.values(filters).filter(Boolean).length;
  const [refinementsOpen, setRefinementsOpen] = useState(activeRefinements > 0);
  const options = useAtomValue(deviceFilterOptionsAtom);
  const devices = useAtomValue(filteredDevicesAtom);
  // Rows animate only when the listed set changes, not when content above moves.
  const membership = devices.map((device) => device.id).join();
  const keys = useMemo(
    () => new Set(devices.map((device) => device.id)),
    [devices],
  );
  const previousKeys = usePreviousKeys(keys);
  const list = useRef<HTMLDivElement>(null);
  const refinements = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return undefined;
    // The list and page ancestors stay untransformed; row animations live inside.
    const measure = () =>
      setScrollMargin(element.getBoundingClientRect().top + window.scrollY);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (layoutRef.current) observer.observe(layoutRef.current);
    if (element.parentElement) observer.observe(element.parentElement);
    if (refinementsOpen && refinements.current)
      observer.observe(refinements.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [layoutRef, refinementsOpen]);
  const focusedIndex = devices.findIndex((device) => device.id === focused);
  // oxlint-disable-next-line react/incompatible-library -- Read live virtual measurements directly rather than compiler-memoizing them.
  const virtualizer = useWindowVirtualizer({
    count: devices.length,
    estimateSize: () => 76,
    scrollMargin,
    overscan: 4,
    getItemKey: useCallback((index: number) => devices[index]!.id, [devices]),
    rangeExtractor: useCallback(
      (range: Parameters<typeof defaultRangeExtractor>[0]) =>
        [
          ...new Set([
            ...defaultRangeExtractor(range),
            ...(focusedIndex < 0 ? [] : [focusedIndex]),
          ]),
        ].toSorted((a, b) => a - b),
      [focusedIndex],
    ),
  });
  const measureRow = useCallback(
    (index: number, height: number) => virtualizer.resizeItem(index, height),
    [virtualizer],
  );

  const searching = search.trim().length > 0;
  const categoryEmpty = new Map([
    ["online", "暂无在线设备"],
    ["offline", "暂无离线设备"],
    ["unknown", "暂无状态未知的设备"],
  ]);
  const emptyTitle = searching
    ? "没有找到相关设备"
    : activeRefinements
      ? "没有符合筛选条件的设备"
      : filter !== "all"
        ? (categoryEmpty.get(filter) ?? "当前视图没有设备")
        : "所选家庭没有设备";
  const emptyDescription = searching
    ? "试试其他名称、别名或型号，或清除搜索。"
    : activeRefinements
      ? "调整房间、分类或能力条件，或清除筛选。"
      : filter !== "all"
        ? "可以切换到全部，查看其他设备。"
        : "刷新设备清单后，已添加的设备会显示在这里。";
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 max-md:items-stretch">
        <SegmentedControl
          label="设备状态"
          variant="underline"
          value={filter}
          onValueChange={setFilter}
          options={availabilityOptions}
        />
        <div className="flex min-w-0 items-center gap-2 max-md:w-full">
          <label className="relative m-0 flex w-60 items-center [&_svg]:absolute [&_svg]:left-2.5 [&_svg]:text-muted max-md:w-auto max-md:min-w-0 max-md:flex-1">
            <Search size={14} />
            <input
              className="h-10 pl-9 text-[13px]"
              aria-label="搜索设备"
              placeholder="搜索名称、别名或型号"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Button
            aria-expanded={refinementsOpen}
            aria-controls="device-refinements"
            icon={<SlidersHorizontal size={14} />}
            onClick={() => setRefinementsOpen(!refinementsOpen)}
          >
            {activeRefinements ? `筛选 · ${activeRefinements}` : "筛选"}
          </Button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {refinementsOpen ? (
          <m.div ref={refinements} className="overflow-hidden" {...expand}>
            <div id="device-refinements" className="mb-4 flex flex-wrap gap-4">
              <div className="m-0 flex min-w-36 flex-1 items-center gap-2 text-[13px] text-muted">
                房间
                <Select
                  label="房间"
                  className="flex-1"
                  value={filters.room}
                  onValueChange={(room) => setFilters({ ...filters, room })}
                  options={[
                    { value: "", label: "全部房间" },
                    ...(filters.room &&
                    !options.rooms.some(([value]) => value === filters.room)
                      ? [{ value: filters.room, label: "原房间已移除" }]
                      : []),
                    ...options.rooms.map(([value, name]) => ({
                      value,
                      label: name,
                    })),
                  ]}
                />
              </div>
              <div className="m-0 flex min-w-36 flex-1 items-center gap-2 text-[13px] text-muted">
                分类
                <Select
                  label="分类"
                  className="flex-1"
                  value={filters.category}
                  onValueChange={(category) =>
                    setFilters({ ...filters, category })
                  }
                  options={[
                    { value: "", label: "全部分类" },
                    ...(filters.category &&
                    !options.categories.some(
                      ([value]) => value === filters.category,
                    )
                      ? [{ value: filters.category, label: "原分类已移除" }]
                      : []),
                    ...options.categories.map(([value, name]) => ({
                      value,
                      label: name,
                    })),
                  ]}
                />
              </div>
              <div className="m-0 flex min-w-36 flex-1 items-center gap-2 text-[13px] text-muted">
                能力
                <Select
                  label="能力"
                  className="flex-1"
                  value={filters.capability}
                  onValueChange={(capability) =>
                    setFilters({ ...filters, capability })
                  }
                  options={[
                    { value: "", label: "全部能力" },
                    ...capabilityOptions.filter(
                      ({ value }) =>
                        options.capabilities.has(value) ||
                        value === filters.capability,
                    ),
                  ]}
                />
              </div>
            </div>
          </m.div>
        ) : null}
      </AnimatePresence>
      <DeviceList showHeader={devices.length > 0 || status === "loading"}>
        {/* Rows keep their identity as filters change: survivors slide into place. */}
        <div
          ref={list}
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
          onFocusCapture={(event) =>
            setFocused(
              event.target.closest<HTMLElement>("[data-virtual-row]")?.dataset
                .virtualRow ?? null,
            )
          }
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setFocused(null);
          }}
        >
          {/* Clear exiting rows before the zero-height list exposes the empty state. */}
          <AnimatePresence
            key={devices.length > 0 ? "populated" : "empty"}
            initial={false}
            custom={keys}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const device = devices[item.index]!;
              return (
                <VirtualRow
                  key={device.id}
                  id={device.id}
                  index={item.index}
                  top={item.start - scrollMargin}
                  gap={item.index === devices.length - 1 ? 0 : 4}
                  membership={membership}
                  entering={!previousKeys.has(device.id)}
                  onSize={measureRow}
                >
                  <DeviceRow>
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg text-muted">
                        {device.camera ? (
                          <Video size={20} strokeWidth={1.4} />
                        ) : (
                          <Box size={20} strokeWidth={1.4} />
                        )}
                      </span>
                      <strong
                        className="truncate text-sm font-medium max-md:text-[14px] max-md:whitespace-normal max-md:wrap-anywhere max-md:leading-[1.5]"
                        title={device.name}
                      >
                        {device.name}
                      </strong>
                    </div>
                    <span
                      className="truncate font-mono text-xs text-muted max-md:hidden"
                      title={device.model}
                    >
                      {device.model}
                    </span>
                    <span
                      className="flex items-center gap-1.5 text-xs text-muted data-[availability=online]:text-sage data-[availability=offline]:text-warning"
                      data-availability={
                        reliable ? device.availability : "unknown"
                      }
                    >
                      <i
                        className={twMerge(
                          "size-1.5 rounded-full",
                          reliable && device.availability === "online"
                            ? "bg-current status-ping"
                            : "border border-current bg-transparent",
                        )}
                      />
                      {!reliable
                        ? "待确认"
                        : device.availability === "online"
                          ? "在线"
                          : device.availability === "offline"
                            ? "离线"
                            : "未知"}
                    </span>
                    {device.camera ? (
                      <Link
                        draggable={false}
                        to="/cameras"
                        className="flex select-none items-center justify-end gap-1 text-xs text-muted hover:text-ink max-md:col-span-full max-md:justify-start max-md:pl-12"
                        aria-label={`查看${device.name}画面`}
                      >
                        查看画面
                        <ArrowUpRight size={13} className="shrink-0" />
                      </Link>
                    ) : (
                      <span />
                    )}
                  </DeviceRow>
                </VirtualRow>
              );
            })}
          </AnimatePresence>
        </div>
        {devices.length === 0 && status === "loading" ? (
          <DeviceRowsSkeleton />
        ) : null}
        {devices.length === 0 && status !== "error" && status !== "loading" ? (
          <EmptyState
            icon={searching ? <Search size={24} /> : <Box size={24} />}
            title={emptyTitle}
            description={emptyDescription}
          >
            {searching ? (
              <Button variant="primary" onClick={() => setSearch("")}>
                清除搜索
              </Button>
            ) : activeRefinements ? (
              <Button
                variant="primary"
                onClick={() =>
                  setFilters({ room: "", category: "", capability: "" })
                }
              >
                清除筛选
              </Button>
            ) : filter !== "all" ? (
              <Button variant="primary" onClick={() => setFilter("all")}>
                查看全部设备
              </Button>
            ) : null}
          </EmptyState>
        ) : null}
      </DeviceList>
    </>
  );
});
