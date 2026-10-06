import { useMemo, useState } from "react";
import { Select } from "../../components/Select";
import { RecordBrowser } from "./RecordBrowser";
import { identified, named, type Parts } from "./presentation";

export function SpatialPart({
  data,
  household,
}: {
  data: Extract<Parts["spatial"], { status: "ready" }>["data"];
  household: Parts["household"] | undefined;
}) {
  const [group, setGroup] = useState<keyof typeof data>("spaces");
  const spaces = useMemo(
    () => new Map(data.spaces.map((space) => [space.id, space.name])),
    [data.spaces],
  );
  const passages = useMemo(
    () => new Map(data.passages.map((passage) => [passage.id, passage.name])),
    [data.passages],
  );
  const devices = useMemo(
    () =>
      new Map(
        household?.status === "ready"
          ? Object.values(household.data.device).map((device) => [
              device.id,
              device.name,
            ])
          : [],
      ),
    [household],
  );
  const spaceName = (id: string) => spaces.get(id) ?? id;
  const target = (binding: (typeof data.observation_bindings)[number]) =>
    binding.space_id !== null
      ? `空间：${spaceName(binding.space_id)}`
      : `通道：${passages.get(binding.passage_id ?? "") ?? binding.passage_id}`;
  const source = (binding: (typeof data.observation_bindings)[number]) => {
    return `${devices.get(binding.device_id) ?? binding.device_id}${binding.channel === null ? "" : ` · 镜头 ${binding.channel}`}`;
  };
  const toolbar = (
    <Select
      className="w-52 max-w-full"
      label="空间资料分类"
      value={group}
      onValueChange={setGroup}
      options={[
        { value: "spaces", label: `空间 · ${data.spaces.length}` },
        { value: "passages", label: `通道 · ${data.passages.length}` },
        {
          value: "observation_bindings",
          label: `观测绑定 · ${data.observation_bindings.length}`,
        },
      ]}
    />
  );
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        这些资料描述空间连通与设备观察范围；停用的观测绑定仍保留在资料中。
      </p>
      {group === "spaces" ? (
        <RecordBrowser
          key="spaces"
          toolbar={toolbar}
          rows={data.spaces}
          identify={identified}
          title={named}
          describe={(space) => space.description}
          label="空间资料"
          columns={[
            { id: "name", header: "空间", accessorFn: (space) => space.name },
            {
              id: "description",
              header: "说明",
              accessorFn: (space) => space.description,
            },
          ]}
        />
      ) : group === "passages" ? (
        <RecordBrowser
          key="passages"
          toolbar={toolbar}
          rows={data.passages}
          identify={identified}
          title={named}
          describe={(passage) =>
            `${spaceName(passage.space_a_id)} ↔ ${spaceName(passage.space_b_id)} · ${passage.description}`
          }
          label="通道资料"
          columns={[
            {
              id: "name",
              header: "通道",
              accessorFn: (passage) => passage.name,
            },
            {
              id: "a",
              header: "空间 A",
              accessorFn: (passage) => spaceName(passage.space_a_id),
            },
            {
              id: "b",
              header: "空间 B",
              accessorFn: (passage) => spaceName(passage.space_b_id),
            },
            {
              id: "description",
              header: "说明",
              accessorFn: (passage) => passage.description,
            },
          ]}
        />
      ) : (
        <RecordBrowser
          key="bindings"
          toolbar={toolbar}
          rows={data.observation_bindings}
          identify={identified}
          title={source}
          describe={(binding) =>
            `${target(binding)} · ${binding.enabled ? "启用" : "停用"} · ${binding.description}`
          }
          label="观测绑定"
          filterColumns={["enabled"]}
          columns={[
            { id: "source", header: "设备 / 镜头", accessorFn: source },
            { id: "target", header: "观察目标", accessorFn: target },
            {
              id: "enabled",
              header: "状态",
              accessorFn: (binding) => (binding.enabled ? "启用" : "停用"),
              filterFn: "equalsString",
            },
            {
              id: "description",
              header: "说明",
              accessorFn: (binding) => binding.description,
            },
          ]}
        />
      )}
    </div>
  );
}
