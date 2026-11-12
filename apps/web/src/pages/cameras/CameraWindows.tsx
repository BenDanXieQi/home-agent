import { formatTime } from "../../modules/presentation/time";
import {
  petSoundLabels,
  windowMarkerMembers,
  windowMarkerTargets,
} from "../../modules/perception/window-presentation";
import {
  associationLabel,
  associationReason,
} from "../../modules/members/attribution";
import { useSearch } from "@tanstack/react-router";
import { CameraAnalysisLayout } from "./CameraAnalysisLayout";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { RequestError } from "../../api/errors";
import { reconnectHouseholdAtom } from "../../modules/household/state";
import { Button } from "../../components/Button";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import type { createPerceptionSourceState } from "../../modules/perception/source-state";
import {
  windowListOptions,
  windowQueryScope,
  windowRequestUnavailable,
  type WindowMarker,
  type WindowListCursor,
} from "../../modules/perception/windows";
import { CameraHeader } from "./CameraHeader";
import { cameraTileClassName } from "./camera-styles";
import { useWindowDetail } from "../../modules/perception/use-window-detail";
import { WindowMedia } from "./WindowMedia";
import { WindowDetail } from "./WindowDetail";
import { RecordingRangePlayer } from "../../modules/recordings/RecordingRangePlayer";

export function CameraWindows({
  source,
  scope,
  visible,
}: {
  source: ReturnType<typeof createPerceptionSourceState>;
  scope: string;
  visible: boolean;
}) {
  const {
    rangeStart,
    rangeEnd,
    activityRun,
    activityFirstAt,
    activityAt,
    seekAt,
    window: windowId,
  } = useSearch({
    from: "/account/cameras/$deviceId/$channel",
  });
  const fromActivity = activityRun !== undefined && activityAt !== undefined;
  const observedAt = seekAt ?? activityAt;
  const accessible = useAtomValue(source.accessibleAtom);
  const playbackTarget = useAtomValue(source.playbackTargetAtom);
  const active = visible && accessible;
  const container = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (visible) return;
    for (const media of container.current?.querySelectorAll<HTMLMediaElement>(
      "video, audio",
    ) ?? [])
      media.pause();
  }, [visible]);
  const device = useAtomValue(source.deviceAtom);
  const client = useQueryClient();
  const [day, setDay] = useState("");
  const [cursor, setCursor] = useState<WindowListCursor>();
  const dayStart = day ? new Date(`${day}T00:00:00`) : undefined;
  const dayEnd = dayStart ? new Date(dayStart) : undefined;
  dayEnd?.setDate(dayEnd.getDate() + 1);
  const query = useQuery({
    ...windowListOptions({
      scopeEpoch: scope,
      ...source.target,
      ...cursor,
      ...(dayStart && dayEnd
        ? { start: dayStart.getTime(), end: dayEnd.getTime() }
        : {}),
    }),
    enabled: (cached) =>
      active && !windowRequestUnavailable(cached.state.error),
  });
  const reconnectHousehold = useSetAtom(reconnectHouseholdAtom);
  const scopeChanged =
    query.error instanceof RequestError &&
    query.error.details.code === "household_scope_changed";
  useEffect(() => {
    if (scopeChanged && query.errorUpdatedAt > 0) reconnectHousehold();
  }, [scopeChanged, query.errorUpdatedAt, reconnectHousehold]);

  useEffect(() => {
    if (active) return;
    // oxlint-disable-next-line typescript/no-floating-promises
    client.cancelQueries({ queryKey: windowQueryScope(scope) });
  }, [active, client, scope]);
  const [selection, select] = useState<WindowMarker>();
  const [recordingWindowId, showRecording] = useState<string>();
  const detail = useWindowDetail(
    selection ? selection.observation?.id : windowId,
    scope,
    active,
  );
  const observation = selection ? selection.observation : detail.window;
  const soundOnly =
    observation != null &&
    observation.gate.visual !== "changed" &&
    (observation.speech.segments.length > 0 ||
      observation.audio.petSounds?.chunks.some(
        (chunk) => chunk.detections.length > 0,
      ));
  const audioOnly = soundOnly && recordingWindowId !== observation.id;
  const markers = query.data?.markers ?? [];
  const focusAt = observedAt ?? rangeStart ?? detail.window?.startedAt;
  const selected =
    selection ??
    markers.find(
      (marker) =>
        focusAt !== undefined &&
        marker.startedAt <= focusAt &&
        focusAt < marker.endedAt,
    );
  const selectedOutsideList =
    selected && !markers.some((marker) => marker.id === selected.id)
      ? selected
      : undefined;
  const playbackStart =
    selection?.startedAt ??
    rangeStart ??
    activityFirstAt ??
    activityAt ??
    detail.window?.startedAt;
  const playbackEnd =
    fromActivity && !selection
      ? activityAt + 1000
      : (selection?.endedAt ?? rangeEnd ?? detail.window?.endedAt);
  return (
    <section ref={container} aria-label="录像与观察记录">
      <CameraAnalysisLayout
        sidebarLabel="观察记录与详情"
        sidebar={
          <>
            <div className="flex items-center justify-between gap-2 px-1 text-sm">
              <h2 className="font-medium">观察记录</h2>
              <span className="text-xs text-muted">按时间回看</span>
            </div>
            <p className="px-1 text-xs text-muted">
              {!query.data
                ? "正在读取记录…"
                : query.data.history.enabled
                  ? "时间标记保留一年"
                  : "历史存储未启用，仅显示当前记录"}
            </p>
            <label className="flex items-center gap-2 px-1 text-sm">
              记录日期
              <input
                type="date"
                aria-label="记录日期"
                value={day}
                className="min-h-10 rounded-lg border border-line bg-surface px-2"
                onChange={(event) => {
                  setDay(event.target.value);
                  setCursor(undefined);
                  select(undefined);
                }}
              />
            </label>
            {cursor || day ? (
              <Button
                onClick={() => {
                  setCursor(undefined);
                  setDay("");
                  select(undefined);
                }}
              >
                返回最新记录
              </Button>
            ) : null}
            {query.data?.history.error ? (
              <Notice tone="warning">{query.data.history.error}</Notice>
            ) : null}
            {fromActivity && !selection && !audioOnly ? (
              <StatusNotice>
                活动观察时间：{formatTime(observedAt)}
                。播放器按此观察时间读取原始录像。
              </StatusNotice>
            ) : null}
            {!accessible || scopeChanged ? (
              <StatusNotice>正在恢复家庭连接…</StatusNotice>
            ) : null}
            {accessible && query.isError && !scopeChanged ? (
              <Notice tone="error">
                观察记录加载失败：{requestErrorMessage(query.error)}
                <Button
                  disabled={!active}
                  onClick={() => {
                    // oxlint-disable-next-line typescript/no-floating-promises
                    query.refetch();
                  }}
                >
                  重新读取
                </Button>
              </Notice>
            ) : null}
            {markers.length || selectedOutsideList ? (
              <ul
                aria-label="最近观察记录"
                className="max-h-80 space-y-2 overflow-y-auto p-1"
              >
                {selectedOutsideList ? (
                  <>
                    <li className="px-1 text-xs text-muted">当前选择</li>
                    <MarkerRow
                      entry={selectedOutsideList}
                      selected
                      select={select}
                    />
                    <li className="px-1 text-xs text-muted">最近观察记录</li>
                  </>
                ) : null}
                {markers.map((marker) => (
                  <MarkerRow
                    key={marker.id}
                    entry={marker}
                    selected={marker.id === selected?.id}
                    select={select}
                  />
                ))}
                {query.data?.next ? (
                  <li>
                    <Button
                      onClick={() => {
                        if (query.data?.next) setCursor(query.data.next);
                        select(undefined);
                      }}
                    >
                      查看更早的记录
                    </Button>
                  </li>
                ) : null}
              </ul>
            ) : null}
            {windowId && !selection ? (
              <WindowDetail key={windowId} detail={detail} active={active} />
            ) : null}
            {!audioOnly && detail.window?.audio.status === "available" ? (
              <WindowMedia
                key={`audio:${detail.window.id}`}
                window={detail.window}
                scope={scope}
                active={active}
              />
            ) : null}
          </>
        }
      >
        <article className={cameraTileClassName}>
          <CameraHeader
            title={
              device?.channels.length && device.channels.length > 1
                ? `${device.name} · 镜头 ${source.target.channel}`
                : (device?.name ?? "视频详情")
            }
            className="min-h-12 pr-4 py-2"
          >
            <span className="text-xs text-muted">{device?.room_name}</span>
            {soundOnly ? (
              <Button
                onClick={() =>
                  showRecording(audioOnly ? observation.id : undefined)
                }
              >
                {audioOnly ? "查看整段录像" : "播放观察声音"}
              </Button>
            ) : null}
          </CameraHeader>
          {audioOnly ? (
            <div className="space-y-3 p-4">
              <p className="text-sm text-muted">
                观察声音：
                {formatTime(observation.startedAt)} –{" "}
                {formatTime(observation.endedAt)}
              </p>
              {detail.window ? (
                detail.window.audio.status === "available" ? (
                  <WindowMedia
                    key={`audio:${detail.window.id}`}
                    window={detail.window}
                    scope={scope}
                    active={active}
                  />
                ) : (
                  <StatusNotice>此观察未保存可播放的音频。</StatusNotice>
                )
              ) : (
                <WindowDetail detail={detail} active={active} />
              )}
            </div>
          ) : windowId && !selection && !detail.window ? (
            <StatusNotice>
              {detail.query.isError
                ? "此观察暂不可读取。"
                : "正在读取观察记录…"}
            </StatusNotice>
          ) : (
            <RecordingRangePlayer
              key={`${playbackStart ?? ""}:${playbackEnd ?? ""}:${fromActivity && !selection ? observedAt : ""}`}
              target={source.target}
              playbackTarget={playbackTarget}
              scope={scope}
              active={active}
              initialStart={playbackStart}
              initialEnd={playbackEnd}
              autoPlay={fromActivity && !selection}
              observedAt={fromActivity && !selection ? observedAt : undefined}
            />
          )}
        </article>
      </CameraAnalysisLayout>
    </section>
  );
}

const MarkerRow = memo(function MarkerRow({
  entry,
  selected,
  select,
}: {
  entry: WindowMarker;
  selected: boolean;
  select: (entry: WindowMarker) => void;
}) {
  const timeRange = `${formatTime(entry.startedAt)} – ${formatTime(entry.endedAt)}`;
  const observation = entry.observation;
  const sounds = new Set(
    observation?.audio.petSounds?.chunks.flatMap((chunk) =>
      chunk.detections.map((detection) => petSoundLabels[detection.kind]),
    ),
  );
  const members = windowMarkerMembers(entry);
  const targets = windowMarkerTargets(entry);
  const mixedPetClasses =
    entry.detectedClasses?.includes("cat") &&
    entry.detectedClasses.includes("dog");
  const reasons = [
    ...(observation?.speech.segments.length ? ["检测到语音"] : []),
    ...sounds,
  ];
  if (!reasons.length && !targets && !members.labels.length)
    reasons.push(
      observation?.gate.visual === "changed" ? "画面变化" : "暂无触发依据",
    );
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={timeRange}
        onClick={() => select(entry)}
        className="w-full rounded-xl border border-line bg-surface p-3 text-left text-sm hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 aria-pressed:border-ink aria-pressed:bg-ink/5"
      >
        <span className="font-medium">{timeRange}</span>
        {reasons.length ? (
          <span className="mt-1 block text-xs text-muted">
            {reasons.join(" · ")}
          </span>
        ) : null}
        {targets ? (
          <span className="mt-1 block text-xs text-muted">
            {targets}
            {members.labels.length ? "" : "，身份未确认"}
          </span>
        ) : null}
        {members.labels.length ? (
          <span className="mt-1 block break-words text-xs text-muted">
            {members.labels.join("；")}
          </span>
        ) : null}
      </button>
      {members.clues.length || mixedPetClasses ? (
        <details className="px-3 pb-2 text-xs text-muted">
          <summary className="cursor-pointer py-1">识别详情</summary>
          {mixedPetClasses ? <p>这段录像的目标检测结果包含猫和狗。</p> : null}
          <ul className="space-y-1">
            {members.clues.map((clue) => (
              <li
                key={`${clue.sourceRunId}:${clue.mediaGeneration}:${clue.trackId}:${clue.memberId}`}
              >
                {formatTime(clue.observedAt, "clock")} ·{" "}
                {associationLabel(clue)}
                <p>{associationReason(clue)}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
});
