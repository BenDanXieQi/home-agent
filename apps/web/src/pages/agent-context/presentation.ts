import { formatTime } from "../../modules/presentation/time";
import type {
  agentContextPartsSchema,
  agentDeviceDeltaSchema,
} from "@home-agent/api/agent-context";
import type { z } from "zod";

export const partLabels = {
  household: "家庭与设备清单",
  spatial: "空间关系",
  device_state: "设备状态",
  members: "成员资料",
  observations: "统一观察",
} as const;
export const statusLabels = {
  ready: "读取成功",
  loading: "读取中",
  failed: "读取失败",
  unavailable: "不可用",
  delta: "增量更新",
};
export const time = (value: string | number | null | undefined) =>
  formatTime(value, "dateTime", "未提供");

export function countPart(
  part:
    | z.infer<typeof agentContextPartsSchema>[keyof typeof partLabels]
    | z.infer<typeof agentDeviceDeltaSchema>
    | undefined,
) {
  if (part?.status === "delta") {
    const properties = part.data.changes.filter(
      (change) => change.entity === "latest",
    );
    const updated = properties.filter(
      (change) => change.op === "upsert",
    ).length;
    const removed = properties.filter(
      (change) => change.op === "remove",
    ).length;
    return (
      [
        updated ? `${updated} 条属性更新` : "",
        removed ? `${removed} 条属性删除` : "",
      ]
        .filter(Boolean)
        .join(" · ") || "无属性变化"
    );
  }
  if (part?.status !== "ready") return "—";
  const data = part.data;
  if ("device" in data)
    return `${Object.keys(data.device).length} 台设备 · ${Object.keys(data.room).length} 个房间`;
  if ("spaces" in data)
    return `${data.spaces.length} 个空间 · ${data.passages.length} 条通道 · ${data.observation_bindings.length} 条观测绑定`;
  if ("latest" in data) return `${Object.keys(data.latest).length} 条属性`;
  if ("members" in data) return `${data.members.length} 位成员`;
  return `${data.records.length} 条观察 · ${new Set(data.records.flatMap((record) => (record.window_id ? [record.window_id] : []))).size} 个音视频窗口引用`;
}

export type Parts = z.infer<typeof agentContextPartsSchema>;
export const identified = (row: { id: string }) => row.id;
export const named = (row: { name: string }) => row.name;

/** UTF-8 byte counts use binary units; display rounding never changes stored counts. */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
