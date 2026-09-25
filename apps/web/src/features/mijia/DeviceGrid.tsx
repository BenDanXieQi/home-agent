import { memo } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { Search, Video, Box, ArrowUpRight } from "lucide-react";
import { Tabs } from "radix-ui";
import { m, AnimatePresence } from "motion/react";
import {
  deviceSearchAtom,
  deviceFilterAtom,
  filteredDevicesAtom,
} from "./state";
import type { MijiaState } from "@home-agent/api/mijia";
export const DeviceGrid = memo(function DeviceGrid({
  status,
  reliable,
}: {
  status: MijiaState["devices"]["status"];
  reliable: boolean;
}) {
  const [search, setSearch] = useAtom(deviceSearchAtom);
  const [filter, setFilter] = useAtom(deviceFilterAtom);
  const devices = useAtomValue(filteredDevicesAtom);
  return (
    <Tabs.Root value={filter} onValueChange={setFilter}>
      <div className="device-filters">
        <Tabs.List aria-label="设备筛选" className="filter-tabs">
          {[
            { value: "all", label: "全部" },
            { value: "online", label: "在线" },
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
            placeholder="搜索名称或型号"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
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
                  className={`device-status ${reliable && device.online ? "online" : ""}`}
                >
                  <i />
                  {!reliable ? "待确认" : device.online ? "在线" : "离线"}
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
                : search || filter !== "all"
                  ? "没有匹配的设备"
                  : "账号下没有设备"}
            </h2>
            <p>
              {search || filter !== "all"
                ? "试试其他名称或筛选条件。"
                : "当前仅显示中国大陆区域的设备。"}
            </p>
          </div>
        ) : null}
      </Tabs.Content>
    </Tabs.Root>
  );
});
