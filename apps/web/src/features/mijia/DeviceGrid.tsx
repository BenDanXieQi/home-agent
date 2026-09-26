import { memo } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { Search, Video, Box, ArrowUpRight } from "lucide-react";
import { Tabs } from "radix-ui";
import { m, AnimatePresence } from "motion/react";
import {
  deviceSearchAtom,
  deviceFilterAtom,
  deviceFiltersAtom,
  deviceFilterOptionsAtom,
  filteredDevicesAtom,
} from "./state";
import type { MijiaState } from "@home-agent/api/mijia";

const capabilityOptions = [
  { value: "readable", label: "可读取" },
  { value: "writeable", label: "可写入" },
  { value: "notify", label: "属性通知" },
  { value: "action", label: "设备动作" },
  { value: "event", label: "设备事件" },
];
export const DeviceGrid = memo(function DeviceGrid({
  status,
  reliable,
}: {
  status: MijiaState["devices"]["status"];
  reliable: boolean;
}) {
  const [search, setSearch] = useAtom(deviceSearchAtom);
  const [filter, setFilter] = useAtom(deviceFilterAtom);
  const [filters, setFilters] = useAtom(deviceFiltersAtom);
  const options = useAtomValue(deviceFilterOptionsAtom);
  const devices = useAtomValue(filteredDevicesAtom);
  const hasFilters =
    search ||
    filter !== "all" ||
    filters.room ||
    filters.category ||
    filters.capability;
  return (
    <Tabs.Root value={filter} onValueChange={setFilter}>
      <div className="device-filters">
        <Tabs.List aria-label="设备筛选" className="filter-tabs">
          {[
            { value: "all", label: "全部" },
            { value: "online", label: "在线" },
            { value: "offline", label: "离线" },
            { value: "unknown", label: "未知" },
            { value: "camera", label: "摄像头" },
          ].map((item) => (
            <Tabs.Trigger key={item.value} value={item.value}>
              {item.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <label className="device-search">
          <Search size={14} />
          <input
            aria-label="搜索设备"
            placeholder="搜索名称、别名或型号"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <div className="device-refinements">
        <label>
          房间
          <select
            value={filters.room}
            onChange={(event) =>
              setFilters({ ...filters, room: event.target.value })
            }
          >
            <option value="">全部房间</option>
            {filters.room &&
            !options.rooms.some(([value]) => value === filters.room) ? (
              <option value={filters.room}>原房间已移除</option>
            ) : null}
            {options.rooms.map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          分类
          <select
            value={filters.category}
            onChange={(event) =>
              setFilters({ ...filters, category: event.target.value })
            }
          >
            <option value="">全部分类</option>
            {filters.category &&
            !options.categories.some(
              ([value]) => value === filters.category,
            ) ? (
              <option value={filters.category}>原分类已移除</option>
            ) : null}
            {options.categories.map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          能力
          <select
            value={filters.capability}
            onChange={(event) =>
              setFilters({ ...filters, capability: event.target.value })
            }
          >
            <option value="">全部能力</option>
            {capabilityOptions
              .filter(
                ({ value }) =>
                  options.capabilities.has(value) ||
                  value === filters.capability,
              )
              .map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </select>
        </label>
      </div>
      <Tabs.Content value={filter}>
        <div className="device-table">
          <div className="device-table-heading">
            <span>设备名称</span>
            <span>型号</span>
            <span>状态</span>
            <span />
          </div>
          <AnimatePresence initial={false}>
            {devices.map((device) => (
              <m.div
                className="device-row"
                key={device.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
              >
                <div className="device-name">
                  <span className="device-symbol">
                    {device.camera ? (
                      <Video size={20} strokeWidth={1.4} />
                    ) : (
                      <Box size={20} strokeWidth={1.4} />
                    )}
                  </span>
                  <strong>{device.name}</strong>
                </div>
                <span className="device-model" title={device.model}>
                  {device.model}
                </span>
                <span
                  className={`device-status ${reliable && device.availability === "online" ? "online" : ""}`}
                >
                  <i />
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
                    to="/cameras"
                    className="device-open"
                    aria-label={`查看${device.name}画面`}
                  >
                    查看画面
                    <ArrowUpRight size={13} />
                  </Link>
                ) : (
                  <span />
                )}
              </m.div>
            ))}
          </AnimatePresence>
        </div>
        {devices.length === 0 && status !== "error" ? (
          <div className="workspace-empty compact">
            <Search size={24} strokeWidth={1.3} />
            <h2>
              {status === "loading"
                ? "正在读取设备…"
                : hasFilters
                  ? "没有匹配的设备"
                  : "所选家庭没有设备"}
            </h2>
            <p>
              {hasFilters
                ? "试试其他名称或筛选条件。"
                : "请确认家庭选择，或刷新设备列表。"}
            </p>
          </div>
        ) : null}
      </Tabs.Content>
    </Tabs.Root>
  );
});
