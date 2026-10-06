import type { z } from "zod";
import type { propertyValueSchema } from "@home-agent/api/observations";
import type { deviceCapabilitySchema } from "@home-agent/api/devices";
const categoryLabels = new Map([
  ["air-conditioner", "空调"],
  ["air-fresh", "新风机"],
  ["air-monitor", "空气检测仪"],
  ["air-purifier", "空气净化器"],
  ["bath-heater", "浴霸"],
  ["cooker", "电饭煲"],
  ["curtain", "窗帘"],
  ["dehumidifier", "除湿机"],
  ["diffuser", "调香机"],
  ["fan", "风扇"],
  ["gateway", "网关"],
  ["kettle", "电水壶"],
  ["light", "灯"],
  ["lock", "门锁"],
  ["massager", "按摩仪"],
  ["mosquito-dispeller", "驱蚊器"],
  ["motion-sensor", "人体传感器"],
  ["occupancy-sensor", "人在传感器"],
  ["nas", "存储设备"],
  ["night-light", "夜灯"],
  ["outlet", "插座"],
  ["pet-feeder", "宠物喂食器"],
  ["remote-control", "遥控器"],
  ["safe-box", "保管箱"],
  ["speaker", "音箱"],
  ["submersion-sensor", "水浸传感器"],
  ["switch", "开关"],
  ["temperature-humidity-sensor", "温湿度计"],
  ["vacuum-cleaner", "吸尘器"],
  ["water-purifier", "净水器"],
]);
export function deviceCategoryLabel(category: string) {
  return categoryLabels.get(category) ?? category;
}

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

export const sourceLabels = {
  push: "实时推送",
  retained: "保留消息",
  read: "属性读取",
  directory: "设备清单读取",
};
export const connectionLabels = {
  connecting: "连接中",
  connected: "已连接",
  closed: "已关闭",
};

const units = new Map([
  ["celsius", "°C"],
  ["percentage", "%"],
  ["lux", "lx"],
  ["seconds", "秒"],
]);

export function deviceUnit(unit: string | null | undefined) {
  return !unit || unit === "none" ? "" : (units.get(unit) ?? unit);
}

/** Preserve raw value types when the supplied specification has no enum label. */
export function formatDevicePropertyValue(
  value: z.infer<typeof propertyValueSchema>,
  metadata: {
    [K in "unit" | "type_name" | "value_list"]?:
      | z.infer<typeof deviceCapabilitySchema>[K]
      | null;
  },
) {
  const label = metadata.value_list?.find(
    (item) => item.value === value,
  )?.description;
  const text =
    label ??
    (metadata.type_name === "on" && typeof value === "boolean"
      ? value
        ? "开启"
        : "关闭"
      : JSON.stringify(value));
  const unit = deviceUnit(metadata.unit);
  return unit ? `${text} ${unit}` : text;
}
