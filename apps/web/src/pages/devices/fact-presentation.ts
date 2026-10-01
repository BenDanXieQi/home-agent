import type { Projection } from "@home-agent/api/household";

const summaryPriority = [
  "temperature",
  "relative-humidity",
  "humidity",
  "target-temperature",
  "brightness",
  "mode",
  "occupancy-status",
  "motion-state",
  "illumination",
  "pm2.5-density",
  "co2-density",
  "battery-level",
];

export function summarizeProperties(
  properties: Projection["latest"][string][],
  device: Projection["device"][string],
) {
  const mainService =
    device.category === "outlet"
      ? "switch"
      : device.category === "camera"
        ? "camera-control"
        : device.category;
  const priority = (property: (typeof properties)[number]) => {
    if (
      property.type_name === "on" &&
      property.service_type_name === mainService
    )
      return -1;
    const index = summaryPriority.indexOf(property.type_name ?? "");
    return index < 0 ? summaryPriority.length : index;
  };
  return properties
    .filter((property) => property.has_value)
    .toSorted((a, b) => priority(a) - priority(b))
    .slice(0, 2);
}

export const qualityLabels = {
  valid: "有效",
  unconfirmed: "待确认",
  unavailable: "来源不可用",
  unknown: "未知",
};
export const reasonLabels = {
  missing: "尚未收到值",
  unverified: "有效期尚未确认",
  cloud_cache: "云端缓存，采样时间未知",
  baseline: "基线报告",
  subscription_pending: "订阅待确认",
  subscription_failed: "订阅失败",
  disconnected: "连接中断",
  offline: "设备离线",
  expired: "观测已过期",
  gap: "上报存在缺口",
  spec_unknown: "规格未知",
  spec_changed: "规格变化，等待新报告",
  invalid_value: "上报不符合规格",
  clock_changed: "系统时间变化",
  stopped: "采集停止",
  capacity: "采集容量不足",
  current: "符合当前有效性策略",
};
export const subscriptionLabels = {
  pending: "等待确认",
  confirmed: "已订阅",
  failed: "订阅失败",
  cancelled: "订阅取消",
  unsupported: "尚未接通",
};
export const collectionLabels = {
  idle: "等待家庭就绪",
  running: "持续采集中",
  paused: "采集已暂停",
  error: "部分采集异常",
};
export function time(value: string | null) {
  return value
    ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false })
    : "—";
}

const units = new Map([
  ["celsius", "°C"],
  ["percentage", "%"],
  ["lux", "lx"],
  ["seconds", "秒"],
]);

export function propertyValue(property: Projection["latest"][string]) {
  if (!property.has_value) return "未知";
  if (property.type_name === "on" && typeof property.value === "boolean")
    return property.value ? "开启" : "关闭";
  return `${JSON.stringify(property.value)}${property.unit && property.unit !== "none" ? ` ${units.get(property.unit) ?? property.unit}` : ""}`;
}
