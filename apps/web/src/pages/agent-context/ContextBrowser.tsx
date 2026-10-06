import { useMemo, useState } from "react";
import type { z } from "zod";
import {
  agentContextPartsSchema,
  type agentContextPublicationSchema,
} from "@home-agent/api/agent-context";
import { Notice } from "../../components/Notice";
import { SpatialPart } from "./SpatialPart";
import { HouseholdPart } from "./HouseholdPart";
import { DevicePart } from "./DevicePart";
import { MembersPart } from "./MembersPart";
import { ObservationsPart } from "./ObservationsPart";
import { RecordBrowser } from "./RecordBrowser";
import { JsonData } from "../../components/json/JsonData";
import {
  countPart,
  identified,
  partLabels,
  statusLabels,
  time,
} from "./presentation";

export function ContextBrowser({
  snapshot,
  message = false,
}: {
  snapshot: z.infer<typeof agentContextPublicationSchema>;
  message?: boolean;
}) {
  const [selected, setSelected] = useState<keyof typeof partLabels>(
    () =>
      agentContextPartsSchema
        .keyof()
        .options.find((name) => snapshot.parts[name]) ?? "household",
  );
  const part = snapshot.parts[selected];
  const household = snapshot.parts.household;
  const spatial = snapshot.parts.spatial;
  const device = snapshot.parts.device_state;
  const deviceChanges =
    device?.status === "delta" ? device.data.changes : undefined;
  const deltaRows = useMemo(
    () =>
      deviceChanges?.map((change, index) => ({
        id: `${index}:${change.entity}:${change.key}`,
        change,
      })) ?? [],
    [deviceChanges],
  );
  const members = snapshot.parts.members;
  const observations = snapshot.parts.observations;
  return (
    <div className="space-y-4">
      <nav
        aria-label="上下文分类"
        className="grid grid-cols-2 gap-2 lg:grid-cols-5"
      >
        {agentContextPartsSchema.keyof().options.map((key) => {
          const label = partLabels[key];
          const item = snapshot.parts[key];
          return (
            <button
              key={key}
              type="button"
              aria-pressed={selected === key}
              onClick={() => setSelected(key)}
              className={`rounded-xl border p-4 text-left focus-visible:outline-2 ${selected === key ? "border-ink bg-surface" : "border-line hover:bg-surface/50"}`}
            >
              <span className="block text-sm font-medium">{label}</span>
              <span className="mt-2 block text-xs text-muted">
                {item?.status === "ready" || item?.status === "delta"
                  ? countPart(item)
                  : item
                    ? statusLabels[item.status]
                    : message
                      ? "本次未提供"
                      : "尚未收到"}
              </span>
              {item?.truncated ? (
                <span className="mt-1 block text-xs text-danger">
                  来源已截断
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <section
        aria-label={partLabels[selected]}
        key={selected}
        className="space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>
            {part
              ? `${statusLabels[part.status]} · 读取时间：${time(part.read_at)}`
              : message
                ? "本次未提供这部分数据"
                : "Agent 尚未收到这部分数据"}
          </span>
        </div>
        {part?.truncated ? (
          <Notice tone="warning">
            来源或交付集合已截断，这部分数据不代表完整历史。
          </Notice>
        ) : null}
        {!part ? (
          <p className="py-6 text-sm text-muted">
            {message
              ? `本次没有提供${partLabels[selected]}，接收消息中省略的部分沿用已接收值，可切换到合并后上下文查看。`
              : `Agent 尚未收到${partLabels[selected]}，可在数据到达后重新读取。`}
          </p>
        ) : part.status !== "ready" && part.status !== "delta" ? (
          <Notice tone={part.status === "failed" ? "error" : "warning"}>
            {statusLabels[part.status]}
            {part.reason ? `：${part.reason}` : "，尚无可浏览的数据。"}
          </Notice>
        ) : null}
        {selected === "household" && household?.status === "ready" ? (
          <HouseholdPart data={household.data} />
        ) : null}
        {selected === "spatial" && spatial?.status === "ready" ? (
          <SpatialPart data={spatial.data} household={household} />
        ) : null}
        {selected === "device_state" && device?.status === "ready" ? (
          <DevicePart data={device.data} household={household} />
        ) : null}
        {selected === "device_state" && device?.status === "delta" ? (
          <>
            <p className="text-xs text-muted">
              这里只展示本次属性与采集状态的增量，完整状态见“合并后上下文”。
            </p>
            <RecordBrowser
              rows={deltaRows}
              identify={identified}
              rawValue={(row) => row.change}
              title={(row) => row.change.key}
              describe={(row) =>
                `${row.change.entity} · ${row.change.op === "upsert" ? "更新" : "删除"}`
              }
              label="设备状态增量"
            />
            {device.data.online ? (
              <RecordBrowser
                rows={device.data.online}
                identify={(row) =>
                  JSON.stringify([row.account_id, row.device_id])
                }
                title={(row) => row.device_id}
                describe={(row) => (row.online ? "在线" : "离线")}
                label="在线状态增量"
              />
            ) : null}
          </>
        ) : null}
        {selected === "members" && members?.status === "ready" ? (
          <MembersPart data={members.data} />
        ) : null}
        {selected === "observations" && observations?.status === "ready" ? (
          snapshot.scope ? (
            <ObservationsPart data={observations.data} scope={snapshot.scope} />
          ) : (
            <Notice tone="warning">
              没有家庭范围信息，无法按引用读取观察材料。
            </Notice>
          )
        ) : null}
        {part ? (
          <JsonData value={part} label={`${partLabels[selected]}完整 JSON`} />
        ) : null}
      </section>
      <JsonData value={snapshot.scope} label="家庭范围与标识" />
    </div>
  );
}
