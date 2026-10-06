import { deviceSubject } from "./receipt-presentation";
import {
  reasonLabels,
  sourceLabels,
  subscriptionLabels,
  collectionLabels,
  connectionLabels,
} from "../../modules/devices/presentation";
import { propertySubject, propertyDisplayValue } from "./receipt-presentation";
import { createAgentDeviceMetadata } from "@home-agent/api/agent-context/devices";
import { memo, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Select } from "../../components/Select";
import { time } from "./presentation";
import type { Parts } from "./presentation";
import { RecordBrowser } from "./RecordBrowser";
import { propertyKey } from "@home-agent/api/observations";

export const DevicePart = memo(function DevicePart({
  data,
  household,
}: {
  data: Extract<Parts["device_state"], { status: "ready" }>["data"];
  household: Parts["household"] | undefined;
}) {
  const [group, setGroup] = useState<keyof typeof data>("latest");
  const metadata = useMemo(
    () => createAgentDeviceMetadata(household),
    [household],
  );
  const rows = useMemo(() => Object.values(data.latest), [data.latest]);
  const health = useMemo(
    () => Object.values(data.source_health),
    [data.source_health],
  );
  const coverage = useMemo(
    () => Object.values(data.device_coverage),
    [data.device_coverage],
  );
  const collection = useMemo(
    () => [data.collection.collection],
    [data.collection],
  );
  const propertyColumns = useMemo<ColumnDef<(typeof rows)[number]>[]>(
    () => [
      {
        id: "room",
        header: "房间",
        accessorFn: (r) =>
          metadata.property(r).device_name === null
            ? "房间未知"
            : (metadata.property(r).room_name ?? "未分配房间"),
        filterFn: "equalsString",
      },
      {
        id: "device",
        header: "设备",
        accessorFn: (r) => metadata.property(r).device_name ?? r.device_id,
        filterFn: "equalsString",
      },
      {
        id: "property",
        header: "属性",
        accessorFn: (r) =>
          metadata.property(r).capability?.description ?? `${r.siid}.${r.piid}`,
      },
      {
        id: "value",
        header: "当前值",
        accessorFn: (r) => propertyDisplayValue(metadata.property(r), r),
      },
      {
        id: "reason",
        header: "值状态",
        accessorFn: (r) => reasonLabels[r.reason],
        filterFn: "equalsString",
      },
      {
        id: "received",
        header: "接收时间",
        accessorFn: (r) => r.evidence?.received_at ?? "",
        cell: ({ row }) => time(row.original.evidence?.received_at),
      },
    ],
    [metadata],
  );
  const onlineColumns = useMemo<ColumnDef<(typeof data.online)[number]>[]>(
    () => [
      {
        id: "name",
        header: "设备",
        accessorFn: (d) => deviceSubject(metadata.device(d)),
      },
      { id: "id", header: "设备标识", accessorFn: (d) => d.device_id },
      {
        id: "online",
        header: "在线状态",
        accessorFn: (d) => (d.online ? "在线" : "离线"),
        filterFn: "equalsString",
      },
    ],
    [metadata],
  );
  const healthColumns = useMemo<
    ColumnDef<(typeof data.source_health)[string]>[]
  >(
    () => [
      { id: "source", header: "来源", accessorFn: (r) => r.source_id },
      {
        id: "status",
        header: "连接状态",
        accessorFn: (r) => connectionLabels[r.status],
      },
      {
        id: "reason",
        header: "说明",
        accessorFn: (r) => r.reason ?? "未提供说明",
      },
      {
        id: "time",
        header: "更新时间",
        accessorFn: (r) => time(r.updated_at),
      },
    ],
    [],
  );
  const coverageColumns = useMemo<
    ColumnDef<(typeof data.device_coverage)[string]>[]
  >(
    () => [
      {
        id: "device",
        header: "设备",
        accessorFn: (r) => deviceSubject(metadata.device(r)),
      },
      {
        id: "properties",
        header: "属性订阅",
        accessorFn: (r) => subscriptionLabels[r.properties],
      },
      {
        id: "online",
        header: "在线状态订阅",
        accessorFn: (r) => subscriptionLabels[r.online],
      },
      {
        id: "reason",
        header: "说明",
        accessorFn: (r) => r.reason ?? "未提供说明",
      },
    ],
    [metadata],
  );
  const collectionColumns = useMemo<
    ColumnDef<typeof data.collection.collection>[]
  >(
    () => [
      {
        id: "status",
        header: "采集状态",
        accessorFn: (r) => collectionLabels[r.status],
      },
      { id: "gaps", header: "缺口", accessorFn: (r) => r.gaps },
      { id: "rejected", header: "拒收", accessorFn: (r) => r.rejected },
      { id: "dropped", header: "丢弃", accessorFn: (r) => r.dropped },
      {
        id: "reason",
        header: "说明",
        accessorFn: (r) =>
          r.reason ?? (r.capacity_degraded ? "采集容量不足" : "未提供说明"),
      },
    ],
    [],
  );
  const toolbar = (
    <Select
      className="w-44 max-w-full"
      label="状态分类"
      value={group}
      onValueChange={setGroup}
      options={[
        { value: "latest", label: `全部属性 · ${rows.length}` },
        { value: "online", label: `在线状态 · ${data.online.length}` },
        { value: "source_health", label: "来源连接健康" },
        { value: "device_coverage", label: "设备订阅覆盖" },
        { value: "collection", label: "采集状态与缺口" },
      ]}
    />
  );
  return (
    <div className="space-y-4">
      {group === "latest" ? (
        <RecordBrowser
          toolbar={toolbar}
          key="latest"
          rows={rows}
          label="设备属性"
          filterColumns={["room", "device", "reason"]}
          columns={propertyColumns}
          identify={(r) =>
            propertyKey(r.account_id, r.device_id, r.siid, r.piid)
          }
          title={(r) => propertySubject(metadata.property(r))}
          describe={(r) =>
            `${propertyDisplayValue(metadata.property(r), r)} · ${reasonLabels[r.reason]} · ${time(r.evidence?.received_at)}`
          }
          render={(r) => (
            <div className="space-y-2 text-sm">
              <p className="break-all text-lg">
                {propertyDisplayValue(metadata.property(r), r)}
              </p>
              <p>
                来源：{r.evidence ? sourceLabels[r.evidence.source] : "未提供"}{" "}
                · {reasonLabels[r.reason]}
              </p>
              <p>接收时间：{time(r.evidence?.received_at)}</p>
              <p>设备采样时间：{time(r.evidence?.observed_at)}</p>
              <p className="text-xs text-muted">
                云端缓存不等于当前实测；无值不等于关闭。
              </p>
            </div>
          )}
        />
      ) : group === "online" ? (
        <RecordBrowser
          toolbar={toolbar}
          key="online"
          rows={data.online}
          label="设备在线状态"
          filterColumns={["online"]}
          columns={onlineColumns}
          identify={(device) =>
            JSON.stringify([device.account_id, device.device_id])
          }
          title={(device) => deviceSubject(metadata.device(device))}
          describe={(device) =>
            `${device.device_id} · ${device.online ? "在线" : "离线"}`
          }
        />
      ) : group === "source_health" ? (
        <RecordBrowser
          toolbar={toolbar}
          key={group}
          rows={health}
          label="来源连接"
          identify={(r) => r.source_id}
          title={(r) => r.source_id}
          describe={(r) =>
            `${connectionLabels[r.status]} · ${r.reason ?? "未提供说明"} · ${time(r.updated_at)}`
          }
          columns={healthColumns}
        />
      ) : group === "device_coverage" ? (
        <RecordBrowser
          toolbar={toolbar}
          key={group}
          rows={coverage}
          label="设备订阅覆盖"
          identify={(r) => JSON.stringify([r.account_id, r.device_id])}
          title={(r) => deviceSubject(metadata.device(r))}
          describe={(r) =>
            `属性 ${subscriptionLabels[r.properties]} · 在线 ${subscriptionLabels[r.online]} · ${r.reason ?? "未提供说明"}`
          }
          columns={coverageColumns}
        />
      ) : (
        <RecordBrowser
          toolbar={toolbar}
          key={group}
          rows={collection}
          label="采集状态"
          identify={() => "collection"}
          title={() => "家庭采集"}
          describe={(r) =>
            `${collectionLabels[r.status]} · 缺口 ${r.gaps} · 拒收 ${r.rejected} · 丢弃 ${r.dropped}`
          }
          columns={collectionColumns}
        />
      )}
    </div>
  );
});
