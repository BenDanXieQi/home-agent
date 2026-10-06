import { memo, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Select } from "../../components/Select";
import { ObjectRecords } from "./ObjectRecords";
import { identified, named } from "./presentation";
import type { Parts } from "./presentation";
import { RecordBrowser } from "./RecordBrowser";

const capabilityLabels = new Map([
  ["readable", "属性读取"],
  ["writeable", "属性写入"],
  ["notify", "属性通知"],
  ["action", "设备动作"],
  ["event", "设备事件"],
]);

const deviceColumns = [
  { id: "name", header: "设备", accessorFn: (d) => d.name },
  {
    id: "room",
    header: "房间",
    accessorFn: (d) => d.room_name ?? "未分配房间",
    filterFn: "equalsString",
  },
  {
    id: "model",
    header: "型号",
    accessorFn: (d) => d.model,
    filterFn: "equalsString",
  },
  {
    id: "online",
    header: "清单在线状态",
    accessorFn: (d) => (d.online ? "在线" : "离线"),
    filterFn: "equalsString",
  },
  {
    id: "properties",
    header: "可读属性",
    accessorFn: (d) => d.read_enabled_properties.length,
  },
  {
    id: "spec",
    header: "规格状态",
    accessorFn: (d) => d.spec_status,
    filterFn: "equalsString",
  },
] satisfies ColumnDef<
  Extract<Parts["household"], { status: "ready" }>["data"]["device"][string]
>[];
const roomColumns = [
  { id: "name", header: "房间", accessorFn: (room) => room.name },
  {
    id: "home",
    header: "家庭标识",
    accessorFn: (room) => room.home_id,
  },
  {
    id: "room",
    header: "房间标识",
    accessorFn: (room) => room.room_id,
  },
] satisfies ColumnDef<
  Extract<Parts["household"], { status: "ready" }>["data"]["room"][string]
>[];

export const HouseholdPart = memo(function HouseholdPart({
  data,
}: {
  data: Extract<Parts["household"], { status: "ready" }>["data"];
}) {
  const [group, setGroup] = useState<keyof typeof data>("device");
  const devices = useMemo(() => Object.values(data.device), [data.device]);
  const rooms = useMemo(
    () => Object.entries(data.room).map(([id, room]) => ({ id, ...room })),
    [data.room],
  );
  const homes = useMemo(
    () => Object.entries(data.home).map(([id, home]) => ({ id, ...home })),
    [data.home],
  );
  const toolbar = (
    <Select
      className="w-44 max-w-full"
      label="清单分类"
      value={group}
      onValueChange={setGroup}
      options={[
        { value: "device", label: `设备 · ${devices.length}` },
        { value: "room", label: `房间 · ${Object.keys(data.room).length}` },
        { value: "home", label: "家庭" },
        {
          value: "specs",
          label: `完整规格 · ${Object.keys(data.specs).length}`,
        },
        { value: "household", label: "家庭运行状态" },
      ]}
    />
  );
  return (
    <div className="space-y-4">
      {group === "device" ? (
        <RecordBrowser
          toolbar={toolbar}
          key="device"
          rows={devices}
          label="设备清单"
          filterColumns={["room", "online", "model", "spec"]}
          columns={deviceColumns}
          identify={identified}
          title={named}
          describe={(d) =>
            `${d.room_name ?? "未分配房间"} · ${d.model} · ${d.online ? "设备清单在线" : "设备清单离线"}`
          }
          render={(d) => (
            <dl className="grid gap-x-8 gap-y-4 text-[13px] sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="mb-1 text-xs text-muted">设备标识</dt>
                <dd className="break-all font-mono">{d.id}</dd>
              </div>
              <div className="min-w-0">
                <dt className="mb-1 text-xs text-muted">设备能力</dt>
                <dd className="flex flex-wrap gap-2">
                  {d.capability_tags.length
                    ? d.capability_tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md bg-surface px-2 py-1 text-xs"
                        >
                          {capabilityLabels.get(tag) ?? tag}
                        </span>
                      ))
                    : "暂无能力资料"}
                </dd>
              </div>
            </dl>
          )}
        />
      ) : group === "room" ? (
        <RecordBrowser
          toolbar={toolbar}
          key="room"
          rows={rooms}
          rawValue={(room) => data.room[room.id]}
          label="房间设备清单"
          columns={roomColumns}
          identify={identified}
          title={named}
          describe={(room) => `${room.room_id} · 家庭 ${room.home_id}`}
        />
      ) : group === "home" ? (
        <RecordBrowser
          toolbar={toolbar}
          key="home"
          rows={homes}
          rawValue={(home) => data.home[home.id]}
          identify={identified}
          title={named}
          describe={(home) => home.home_id}
        />
      ) : (
        <ObjectRecords toolbar={toolbar} key={group} value={data[group]} />
      )}
    </div>
  );
});
