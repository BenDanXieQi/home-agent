import { observationReasonLabels } from "../../modules/agent-context/presentation";
import { useObservationMaterials } from "../../modules/agent-context/materials";
import { Button } from "../../components/Button";
import {
  type agentContextScopeSchema,
  type memberSightingRecordSchema,
} from "@home-agent/api/agent-context";
import type { z } from "zod";
import type { PerceptionWindow } from "../../modules/perception/windows";
import { Notice } from "../../components/Notice";
import { memo, useMemo, useState } from "react";
import { JsonData } from "../../components/json/JsonData";
import { WindowView } from "./WindowView";
import { RecordBrowser } from "./RecordBrowser";
import { identified, time, type Parts, statusLabels } from "./presentation";
import { useObservationPlayback } from "../../modules/playback/use-observation-playback";
import { observationPlaybackSourceSchema } from "../../modules/playback/observation";
import { ObservationPlaybackLink } from "../../components/ObservationPlaybackLink";
import { WindowMaterialSummary } from "../../components/WindowMaterialSummary";

function WindowEvidence({ window }: { window: PerceptionWindow }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded-xl border border-line p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer">
        音视频依据 · {time(window.startedAt)} · 镜头 {window.run.channel}
      </summary>
      {open ? (
        <div className="mt-3">
          <WindowView window={window} />
        </div>
      ) : null}
    </details>
  );
}

function ObservationView({
  record,
  sightings,
  window,
  scope,
}: {
  record: Extract<
    Parts["observations"],
    { status: "ready" }
  >["data"]["records"][number];
  sightings: z.infer<typeof memberSightingRecordSchema>[];
  window: PerceptionWindow | undefined;
  scope: string;
}) {
  const playbackSource = window
    ? {
        deviceId: window.run.deviceId,
        channel: window.run.channel,
        sourceRunId: window.videoRun?.runId ?? window.run.runId,
        firstObservedAt: window.startedAt,
        lastObservedAt: window.endedAt,
      }
    : sightings[0]?.data;
  const { deviceId, channel, sourceRunId, firstObservedAt, lastObservedAt } =
    playbackSource ?? {};
  const windowId = window?.id;
  const recordingAt = window
    ? Math.floor((window.startedAt + window.endedAt) / 2)
    : undefined;
  const activities = useMemo(() => {
    if (
      deviceId === undefined ||
      channel === undefined ||
      sourceRunId === undefined ||
      firstObservedAt === undefined ||
      lastObservedAt === undefined
    )
      return [];
    return [
      {
        id: record.id,
        windowId,
        recordingAt,
        source: observationPlaybackSourceSchema.parse({
          deviceId,
          channel,
          sourceRunId,
          firstObservedAt,
          lastObservedAt,
        }),
      },
    ];
  }, [
    record.id,
    windowId,
    recordingAt,
    deviceId,
    channel,
    sourceRunId,
    firstObservedAt,
    lastObservedAt,
  ]);
  const playback = useObservationPlayback(activities, scope);
  return (
    <div className="space-y-3 text-sm">
      <p>
        观察线索：
        {record.reasons
          .map((reason) => observationReasonLabels[reason])
          .join("、")}
      </p>
      {activities.map((activity) => (
        <ObservationPlaybackLink
          key={activity.id}
          source={activity.source}
          windowId={activity.windowId}
          availability={playback.get(activity.id)}
        />
      ))}
      {record.window_id ? (
        <p className="text-xs text-muted">
          画面变化、声音和转写属于这个窗口，不表示由下列成员引发或说出。
        </p>
      ) : (
        <p className="text-xs text-muted">
          当前没有可关联的本地窗口；仍可按来源时间查找摄像头录像。
        </p>
      )}
      {sightings.map((sighting) => (
        <div
          key={sighting.id}
          className="space-y-2 rounded-xl border border-line p-3"
        >
          <p>{sighting.summary}</p>
          <p>
            确定性：{sighting.certainty} · {time(sighting.data.firstObservedAt)}{" "}
            — {time(sighting.data.lastObservedAt)}
          </p>
          <p>
            来源：{sighting.data.cameraRoomName} / {sighting.data.deviceName} ·
            镜头 {sighting.data.channel}
          </p>
          <p className="text-xs text-muted">
            出现跨度不证明持续在场，暂定归因不表示确认身份。
          </p>
          <JsonData value={sighting} label="成员记录与当前归因" />
        </div>
      ))}
      {window ? <WindowEvidence key={window.id} window={window} /> : null}
    </div>
  );
}

function ObservationReference({
  record,
  scope,
}: {
  record: Extract<
    Parts["observations"],
    { status: "ready" }
  >["data"]["records"][number];
  scope: z.infer<typeof agentContextScopeSchema>;
}) {
  const materials = useObservationMaterials(scope, record);
  const available = materials.flatMap(({ query }) =>
    query.isSuccess ? [query.data] : [],
  );
  return (
    <div className="space-y-3">
      <div className="space-y-3 rounded-xl border border-line p-3">
        <p className="text-sm font-medium">接收时材料摘要</p>
        {record.window_material ? (
          <WindowMaterialSummary material={record.window_material} />
        ) : null}
        {record.member_sighting_ids.map((id) => (
          <p key={id} className="break-words text-xs text-muted">
            成员出现归因修订：{record.member_sighting_revisions[id]} · {id}
          </p>
        ))}
      </div>
      <p className="text-xs text-muted">
        以下材料按引用从 Backend
        另行读取，反映当前可用内容，不属于当时收到的消息，也不会写回 Agent
        上下文。
      </p>
      {materials.map(({ reference, query }) => {
        const label =
          reference.kind === "member_sighting" ? "成员记录" : "音视频窗口";
        return query.isError ? (
          <Notice key={`${reference.kind}:${reference.id}`} tone="warning">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-all">
                {label} {reference.id} 已过期、被移除或暂时无法读取。
              </span>
              <Button
                size="small"
                status={query.isFetching ? "pending" : "idle"}
                onClick={() => {
                  query.refetch().catch(() => {
                    console.warn("Observation material retry failed");
                  });
                }}
              >
                重试{label}
              </Button>
            </div>
          </Notice>
        ) : query.isPending ? (
          <output
            key={`${reference.kind}:${reference.id}`}
            className="block break-all text-xs text-muted"
          >
            正在读取{label} {reference.id}…
          </output>
        ) : null;
      })}
      {available.length ? (
        <ObservationView
          record={record}
          scope={scope.scope_epoch}
          sightings={available.flatMap((item) =>
            item.kind === "member_sighting" ? [item.record] : [],
          )}
          window={
            available.flatMap((item) =>
              item.kind === "perception_window" ? [item.window] : [],
            )[0]
          }
        />
      ) : null}
    </div>
  );
}

export const ObservationsPart = memo(function ObservationsPart({
  data,
  scope,
}: {
  data: Extract<Parts["observations"], { status: "ready" }>["data"];
  scope: z.infer<typeof agentContextScopeSchema>;
}) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        这里展示观察索引、材料引用和接收时材料摘要。展开记录才读取源内容；声音不归因给成员，画面变化不是事件结论。
      </p>
      <p className="text-xs text-muted">
        最新观察，整理于 {time(data.as_of)}
        。成员保留最后出现，摄像头按线索类型保留最新记录；历史按需查询。
      </p>
      {Object.entries(data.sources).map(([name, source]) => (
        <p
          key={name}
          className={`text-xs ${source.status === "failed" ? "text-danger" : "text-muted"}`}
        >
          {name === "member_sightings" ? "成员历史来源" : "感知来源"}：
          {statusLabels[source.status]}
          {source.truncated ? " · 已截断" : ""} · {time(source.read_at)}
        </p>
      ))}
      <RecordBrowser
        rows={data.records}
        label="统一观察"
        initialSorting={[{ id: "started", desc: true }]}
        columns={[
          {
            id: "started",
            header: "开始时间",
            accessorFn: (r) => r.startedAt,
            cell: ({ row }) => time(row.original.startedAt),
          },
          {
            id: "ended",
            header: "结束时间",
            accessorFn: (r) => r.endedAt,
            cell: ({ row }) => time(row.original.endedAt),
          },
          {
            id: "reasons",
            header: "观察线索",
            accessorFn: (r) =>
              r.reasons
                .map((reason) => observationReasonLabels[reason])
                .join("、"),
          },
          {
            id: "members",
            header: "成员记录引用",
            accessorFn: (r) => r.member_sighting_ids.length,
          },
          {
            id: "window",
            header: "音视频窗口",
            accessorFn: (r) => r.window_id ?? "无窗口引用",
          },
        ]}
        identify={identified}
        title={(record) =>
          record.reasons
            .map((reason) => observationReasonLabels[reason])
            .join("、")
        }
        describe={(record) =>
          `${time(record.startedAt)} — ${time(record.endedAt)} · ${record.member_sighting_ids.length} 条成员记录引用`
        }
        render={(record) => (
          <ObservationReference key={record.id} record={record} scope={scope} />
        )}
      />
    </div>
  );
});
