import { useState, type ReactNode } from "react";
import {
  spaceSaveSchema,
  passageSaveSchema,
  observationBindingSaveSchema,
  type spatialSnapshotSchema,
} from "@home-agent/api/spatial";
import type { inventoryDeviceSchema } from "@home-agent/api/devices";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";

type Snapshot = ReturnType<typeof spatialSnapshotSchema.parse>;
type FormActions = { pending: boolean; onCancel: () => void };
type Scope = Snapshot["scope"];

function FormFrame({
  title,
  pending,
  error,
  onCancel,
  children,
  onSubmit,
}: FormActions & {
  title: string;
  error: string;
  children: ReactNode;
  onSubmit: (data: FormData) => void;
}) {
  return (
    <form
      className="mx-auto w-full max-w-3xl"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) onSubmit(new FormData(event.currentTarget));
      }}
    >
      <h2 className="mb-6 text-2xl font-medium tracking-tight">{title}</h2>
      <fieldset
        disabled={pending}
        className="min-w-0 rounded-2xl bg-surface p-2"
      >
        <legend className="sr-only">{title}</legend>
        <div className="grid gap-5 rounded-xl bg-white px-5 py-6 shadow-surface md:px-7">
          {children}
        </div>
      </fieldset>
      {error ? (
        <Notice tone="error" className="mt-4">
          {error}
        </Notice>
      ) : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" disabled={pending} onClick={onCancel}>
          取消
        </Button>
        <Button
          type="submit"
          variant="primary"
          status={pending ? "pending" : "idle"}
        >
          保存
        </Button>
      </div>
    </form>
  );
}

function NameAndDescription({
  record,
}: {
  record: Snapshot["spaces"][number] | null;
}) {
  return (
    <>
      <label className="m-0 grid gap-2 text-xs">
        名称
        <input
          name="name"
          required
          maxLength={100}
          defaultValue={record?.name ?? ""}
          placeholder="例如：客厅、卧室门"
        />
      </label>
      <DescriptionField description={record?.description ?? ""} />
    </>
  );
}

function DescriptionField({ description }: { description: string }) {
  return (
    <label className="m-0 grid gap-2 text-xs">
      说明（选填）
      <textarea
        name="description"
        rows={4}
        maxLength={2000}
        defaultValue={description}
        placeholder="补充覆盖范围、画面方向、遮挡或其他限制…"
        className="w-full resize-y rounded-lg bg-surface p-3 text-sm leading-6"
      />
    </label>
  );
}

export function SpaceForm({
  scope,
  record,
  onSave,
  ...actions
}: FormActions & {
  scope: Scope;
  record: Snapshot["spaces"][number] | null;
  onSave: (input: ReturnType<typeof spaceSaveSchema.parse>) => void;
}) {
  const [id] = useState(() => record?.id ?? crypto.randomUUID());
  const [error, setError] = useState("");
  return (
    <FormFrame
      {...actions}
      title={record ? "编辑空间" : "新增空间"}
      error={error}
      onSubmit={(data) => {
        const input = spaceSaveSchema.safeParse({
          id,
          scope,
          ...(record
            ? { operation: "update", expected_updated_at: record.updated_at }
            : { operation: "create" }),
          name: data.get("name"),
          description: data.get("description"),
        });
        if (!input.success) {
          setError("请填写非空名称，并检查内容长度。");
          return;
        }
        setError("");
        onSave(input.data);
      }}
    >
      <NameAndDescription record={record} />
    </FormFrame>
  );
}

export function PassageForm({
  scope,
  record,
  spaces,
  onSave,
  ...actions
}: FormActions & {
  scope: Scope;
  record: Snapshot["passages"][number] | null;
  spaces: Snapshot["spaces"];
  onSave: (input: ReturnType<typeof passageSaveSchema.parse>) => void;
}) {
  const [id] = useState(() => record?.id ?? crypto.randomUUID());
  const [endpoints, setEndpoints] = useState({
    space_a_id: record?.space_a_id ?? "",
    space_b_id: record?.space_b_id ?? "",
  });
  const [error, setError] = useState("");
  return (
    <FormFrame
      {...actions}
      title={record ? "编辑通道" : "新增通道"}
      error={error}
      onSubmit={(data) => {
        if (
          !spaces.some((space) => space.id === endpoints.space_a_id) ||
          !spaces.some((space) => space.id === endpoints.space_b_id)
        ) {
          setError("所选空间已不可用，请重新选择。");
          return;
        }
        const input = passageSaveSchema.safeParse({
          id,
          scope,
          ...(record
            ? { operation: "update", expected_updated_at: record.updated_at }
            : { operation: "create" }),
          name: data.get("name"),
          description: data.get("description"),
          space_a_id: endpoints.space_a_id,
          space_b_id: endpoints.space_b_id,
        });
        if (!input.success) {
          setError("请填写名称，并选择两个不同的空间。");
          return;
        }
        setError("");
        onSave(input.data);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {(["space_a_id", "space_b_id"] as const).map((field, index) => (
          <label key={field} className="m-0 grid gap-2 text-xs">
            {index === 0 ? "一端空间" : "另一端空间"}
            <select
              name={field}
              required
              value={endpoints[field]}
              onChange={(event) =>
                setEndpoints({ ...endpoints, [field]: event.target.value })
              }
            >
              {endpoints[field] &&
              !spaces.some((space) => space.id === endpoints[field]) ? (
                <option value={endpoints[field]} disabled>
                  原空间已不可用，请重新选择
                </option>
              ) : null}
              <option value="" disabled>
                选择空间
              </option>
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name} · {space.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <NameAndDescription record={record} />
    </FormFrame>
  );
}

export function BindingForm({
  scope,
  record,
  snapshot,
  devices,
  onSave,
  ...actions
}: FormActions & {
  scope: Scope;
  record: Snapshot["observation_bindings"][number] | null;
  snapshot: Snapshot;
  devices: ReturnType<typeof inventoryDeviceSchema.parse>[];
  onSave: (
    input: ReturnType<typeof observationBindingSaveSchema.parse>,
  ) => void;
}) {
  const [id] = useState(() => record?.id ?? crypto.randomUUID());
  const [deviceId, setDeviceId] = useState(record?.device_id ?? "");
  const [channel, setChannel] = useState(record?.channel?.toString() ?? "");
  const [error, setError] = useState("");
  const device = devices.find((value) => value.id === deviceId);
  const unavailableSource = !!deviceId && !device;
  const [selectedTarget, setSelectedTarget] = useState(() =>
    record?.space_id
      ? `space:${record.space_id}`
      : record?.passage_id
        ? `passage:${record.passage_id}`
        : "",
  );
  const availableTarget = selectedTarget.startsWith("space:")
    ? snapshot.spaces.some((space) => `space:${space.id}` === selectedTarget)
    : snapshot.passages.some(
        (passage) => `passage:${passage.id}` === selectedTarget,
      );
  return (
    <FormFrame
      {...actions}
      title={record ? "编辑观测绑定" : "新增观测绑定"}
      error={error}
      onSubmit={(data) => {
        if (!availableTarget) {
          setError("所选观察目标已不可用，请重新选择。");
          return;
        }
        const target = selectedTarget;
        const [targetType, targetId] = (
          typeof target === "string" ? target : ""
        ).split(":");
        const input = observationBindingSaveSchema.safeParse({
          id,
          scope,
          ...(record
            ? { operation: "update", expected_updated_at: record.updated_at }
            : { operation: "create" }),
          device_id: deviceId,
          channel: channel ? Number(channel) : null,
          space_id: targetType === "space" ? targetId : null,
          passage_id: targetType === "passage" ? targetId : null,
          description: data.get("description"),
          enabled: data.has("enabled"),
        });
        if (!input.success) {
          setError("请选择设备、有效镜头和一个观察目标，并检查说明长度。");
          return;
        }
        setError("");
        onSave(input.data);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="m-0 grid gap-2 text-xs">
          设备
          <select
            required
            value={deviceId}
            onChange={(event) => {
              const next = devices.find(
                (value) => value.id === event.target.value,
              );
              setDeviceId(event.target.value);
              setChannel(
                next?.camera
                  ? (next.channels[0]?.toString() ?? "")
                  : event.target.value === record?.device_id
                    ? (record.channel?.toString() ?? "")
                    : "",
              );
            }}
          >
            <option value="" disabled>
              从设备清单选择
            </option>
            {record &&
            !devices.some((value) => value.id === record.device_id) ? (
              <option value={record.device_id}>
                {record.device_id}（当前不可用）
              </option>
            ) : null}
            {devices.map((value) => (
              <option key={value.id} value={value.id}>
                {value.name} · {value.id}
              </option>
            ))}
          </select>
        </label>
        <label className="m-0 grid gap-2 text-xs">
          镜头
          <select
            value={channel}
            required={!!device?.camera}
            disabled={!device?.camera || actions.pending}
            onChange={(event) => setChannel(event.target.value)}
          >
            {!device?.camera ? (
              <option value={channel}>
                {channel ? `镜头 ${channel}` : "普通传感器无需镜头"}
              </option>
            ) : (
              <>
                <option value="" disabled>
                  选择镜头
                </option>
                {device.channels.map((value) => (
                  <option key={value} value={value}>
                    镜头 {value}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
      </div>
      {unavailableSource ? (
        <p className="text-xs leading-6 text-muted">
          原来源当前不在可选设备清单中，可维护说明、目标或启停状态；更换来源需选择当前可用设备。
        </p>
      ) : null}
      <label className="m-0 grid gap-2 text-xs">
        观察目标
        <select
          name="target"
          required
          value={selectedTarget}
          onChange={(event) => setSelectedTarget(event.target.value)}
        >
          {selectedTarget && !availableTarget ? (
            <option value={selectedTarget} disabled>
              原目标已不可用，请重新选择
            </option>
          ) : null}
          <option value="" disabled>
            选择一个空间或通道
          </option>
          <optgroup label="空间">
            {snapshot.spaces.map((space) => (
              <option key={space.id} value={`space:${space.id}`}>
                {space.name} · {space.id.slice(0, 8)}
              </option>
            ))}
          </optgroup>
          <optgroup label="通道">
            {snapshot.passages.map((passage) => (
              <option key={passage.id} value={`passage:${passage.id}`}>
                {passage.name} · {passage.id.slice(0, 8)}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <DescriptionField description={record?.description ?? ""} />
      <label className="m-0 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={record?.enabled ?? true}
        />
        采用这条观测说明
      </label>
      <p className="text-xs leading-6 text-muted">
        启停仅控制说明的采用。设备移动或镜头转动后，请检查方向与覆盖范围。
      </p>
    </FormFrame>
  );
}
