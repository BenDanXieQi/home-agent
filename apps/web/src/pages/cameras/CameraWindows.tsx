import { formatTime } from "../../modules/presentation/time";
import { petSoundLabels } from "../../modules/perception/window-presentation";
import { findPlayableObservationWindow } from "../../modules/playback/observation";
import { useSearch } from "@tanstack/react-router";
import { CameraAnalysisLayout } from "./CameraAnalysisLayout";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Video } from "lucide-react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import type { createPerceptionSourceState } from "../../modules/perception/source-state";
import {
  windowListOptions,
  cachedWindowListOptions,
  windowQueryScope,
  windowRequestUnavailable,
  type WindowListEntry,
  type WindowListCursor,
} from "../../modules/perception/windows";
import { useWindowMediaState } from "../../modules/perception/use-window-input-state";
import {
  windowTime,
  mediaStateLabel,
  candidateLabel,
} from "../../modules/perception/window-presentation";
import { CameraHeader } from "./CameraHeader";
import { cameraTileClassName } from "./camera-styles";
import { useWindowDetail } from "../../modules/perception/use-window-detail";
import { WindowMedia } from "./WindowMedia";
import { WindowDetail } from "./WindowDetail";

const windowDisplayBatch = 50;

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
    activityRun,
    activityFirstAt,
    activityAt,
    window: windowId,
  } = useSearch({
    from: "/account/cameras/$deviceId/$channel",
  });
  const fromActivity = activityRun !== undefined && activityAt !== undefined;
  const accessible = useAtomValue(source.accessibleAtom);
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
  const [visibleCount, setVisibleCount] = useState(windowDisplayBatch);
  const dayStart = day ? new Date(`${day}T00:00:00`) : undefined;
  const dayEnd = dayStart ? new Date(dayStart) : undefined;
  dayEnd?.setDate(dayEnd.getDate() + 1);
  const query = useQuery({
    ...(fromActivity && !day && !cursor
      ? cachedWindowListOptions({ scopeEpoch: scope, ...source.target })
      : windowListOptions({
          scopeEpoch: scope,
          ...source.target,
          ...cursor,
          ...(dayStart && dayEnd
            ? { start: dayStart.getTime(), end: dayEnd.getTime() }
            : {}),
        })),
    enabled: (cached) =>
      active && !windowRequestUnavailable(cached.state.error),
  });
  useEffect(() => {
    if (active) return;
    // A lost subscription pauses requests without releasing the selected local media.
    // TanStack owns cancellation failures and always resolves this Promise.
    // oxlint-disable-next-line typescript/no-floating-promises
    client.cancelQueries({ queryKey: windowQueryScope(scope) });
  }, [active, client, scope]);
  const [selection, select] = useState<WindowListEntry>();
  if (!fromActivity && !selection && active && !query.isError) {
    const playable = query.data?.windows.filter(
      (entry) =>
        entry.sampledMedia?.state === "ready" &&
        entry.sampledMedia.readableUntil > query.dataUpdatedAt,
    );
    if (playable?.length === 1) select(playable[0]);
  }
  const windows = query.data?.windows ?? [];
  const activityWindow =
    activityRun !== undefined && activityAt !== undefined
      ? findPlayableObservationWindow(
          windows,
          {
            sourceRunId: activityRun,
            firstObservedAt: activityFirstAt ?? activityAt,
            lastObservedAt: activityAt,
          },
          query.dataUpdatedAt,
          windowId,
        )
      : undefined;
  if (fromActivity && !selection && activityWindow) select(activityWindow);
  const activityUnavailable =
    fromActivity && query.isSuccess && !activityWindow;
  const activityUnavailableReason =
    windows.length &&
    !windows.some((entry) => entry.videoRun?.runId === activityRun)
      ? "该活动来源运行的片段已不在当前缓存中；片段最多保留 30 分钟，后台重启也会清理。"
      : "该活动观察期间没有保留的筛选片段，可能未生成或已清理。";
  const selected =
    windows.find((entry) => entry.id === selection?.id) ??
    selection ??
    activityWindow;
  const visibleWindows = windows.slice(0, visibleCount);
  // Keep an activity target visible without rendering every newer cache entry.
  const selectedOutsideList =
    selected && windows.indexOf(selected) >= visibleCount
      ? selected
      : undefined;
  const detail = useWindowDetail(selected, scope, active);
  const media =
    detail.window &&
    !windowRequestUnavailable(detail.query.error) &&
    detail.window.gate.candidate !== "none" ? (
      <WindowMedia
        key={selected?.id}
        window={detail.window}
        scope={scope}
        active={active}
        autoPlay={fromActivity}
        observedAt={
          selected?.id === activityWindow?.id ? activityAt : undefined
        }
      />
    ) : null;
  return (
    <section ref={container} aria-label="筛选片段">
      <CameraAnalysisLayout
        sidebarLabel="片段列表与详情"
        sidebar={
          <>
            <div className="flex items-center justify-between gap-2 px-1 text-sm">
              <h2 className="font-medium">筛选片段</h2>
              <span className="text-xs text-muted">视频缓存 30 分钟</span>
            </div>
            <p className="px-1 text-xs text-muted">
              {!query.data
                ? "正在读取记录…"
                : query.data.history.enabled
                  ? "文字与时间记录保留一年"
                  : "历史存储未启用，仅显示当前缓存"}
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
                  setVisibleCount(windowDisplayBatch);
                  select(undefined);
                }}
              />
            </label>
            {cursor || day ? (
              <Button
                onClick={() => {
                  setCursor(undefined);
                  setDay("");
                  setVisibleCount(windowDisplayBatch);
                  select(undefined);
                }}
              >
                返回最新记录
              </Button>
            ) : null}
            {query.data?.history.error ? (
              <Notice tone="warning">{query.data.history.error}</Notice>
            ) : null}
            {fromActivity ? (
              <StatusNotice>
                活动观察时间：{formatTime(activityAt)}
                {query.isSuccess
                  ? activityWindow
                    ? activityAt <= activityWindow.endedAt
                      ? "。已定位该时刻所在的采样片段，原观察帧是否保留见播放器提示。"
                      : "。已定位该活动期间最近的筛选片段。"
                    : `。${activityUnavailableReason}`
                  : "。正在查找对应片段。"}
              </StatusNotice>
            ) : null}
            {!accessible ? (
              <StatusNotice>正在恢复家庭连接…</StatusNotice>
            ) : null}
            {query.isError ? (
              <Notice tone="error">
                片段加载失败：{requestErrorMessage(query.error)}
                <Button
                  disabled={!active}
                  onClick={() => {
                    // Refetch exposes request failures through query.error.
                    // oxlint-disable-next-line typescript/no-floating-promises
                    query.refetch();
                  }}
                >
                  重新读取
                </Button>
              </Notice>
            ) : null}
            {windows.length ? (
              <ul
                aria-label="最近片段"
                className="max-h-80 space-y-2 overflow-y-auto p-1"
              >
                {selectedOutsideList ? (
                  <>
                    <li className="px-1 text-xs text-muted">当前选择</li>
                    <WindowRow
                      entry={selectedOutsideList}
                      selected
                      select={select}
                    />
                    <li className="px-1 text-xs text-muted">最近片段</li>
                  </>
                ) : null}
                {visibleWindows.map((entry) => (
                  <WindowRow
                    key={entry.id}
                    entry={entry}
                    selected={entry.id === selected?.id}
                    select={select}
                  />
                ))}
                {visibleCount < windows.length ? (
                  <li>
                    <Button
                      onClick={() => {
                        setVisibleCount((count) => count + windowDisplayBatch);
                      }}
                    >
                      显示更多片段
                    </Button>
                  </li>
                ) : null}
                {query.data?.next ? (
                  <li>
                    <Button
                      onClick={() => {
                        if (query.data?.next) setCursor(query.data.next);
                        setVisibleCount(windowDisplayBatch);
                        select(undefined);
                      }}
                    >
                      查看更早的记录
                    </Button>
                  </li>
                ) : null}
              </ul>
            ) : null}
            {selected ? (
              <WindowDetail key={selected.id} detail={detail} active={active} />
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
          </CameraHeader>
          {media ?? (
            <div className="aspect-video max-h-[65dvh]">
              <EmptyState
                icon={<Video size={24} />}
                title={
                  query.isPending
                    ? "正在加载片段…"
                    : selected?.gate.candidate === "none"
                      ? "仅文字记录"
                      : selected
                        ? "片段暂未就绪"
                        : activityUnavailable
                          ? "活动片段未保留"
                          : windows.length
                            ? "选择片段"
                            : "暂无片段"
                }
                description={
                  selected?.gate.candidate === "none"
                    ? "此片段没有可回放的画面，可在详情中查看语音文字。"
                    : activityUnavailable
                      ? `${activityUnavailableReason} 活动记录仍然保留。`
                      : windows.length
                        ? "选择列表中的片段查看内容。"
                        : "视频缓存最多保留 30 分钟；启用历史存储后，文字与时间记录保留一年，可查找对应 SD 录像。"
                }
                className="h-full min-h-0 rounded-none bg-surface shadow-none"
              />
            </div>
          )}
        </article>
      </CameraAnalysisLayout>
    </section>
  );
}

const WindowRow = memo(function WindowRow({
  entry,
  selected,
  select,
}: {
  entry: WindowListEntry;
  selected: boolean;
  select: (entry: WindowListEntry) => void;
}) {
  const state = useWindowMediaState(entry.sampledMedia);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => select(entry)}
        className="w-full rounded-xl border border-line bg-surface p-3 text-left text-sm hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 aria-pressed:border-ink aria-pressed:bg-ink/5"
      >
        <span className="flex flex-wrap justify-between gap-2 font-medium">
          <span>
            {formatTime(entry.startedAt)} – {windowTime(entry.endedAt)}
          </span>
          <span>
            {entry.gate.visual === "changed"
              ? entry.speechCount > 0
                ? "画面变化 · 有人说话"
                : "画面变化"
              : entry.speechCount > 0
                ? "有人说话"
                : candidateLabel(entry)}
          </span>
        </span>
        <span className="mt-1 block text-xs text-muted">
          {!state || state === "expired" || state === "evicted"
            ? "文字记录 · 可查找 SD 录像"
            : state === "ready"
              ? "缓存可播放"
              : mediaStateLabel(state)}
          {entry.incomplete ? " · 不完整窗口" : ""}
        </span>
        {entry.petSoundKinds?.length ? (
          <span className="mt-1 block text-xs">
            {entry.petSoundKinds.map((kind) => petSoundLabels[kind]).join("、")}
          </span>
        ) : null}
        {entry.speechCount > 0 ? (
          <span className="mt-1 block text-xs">
            语音文字 {entry.speechCount} 段
          </span>
        ) : null}
        {entry.identityCount > 0 ? (
          <span className="mt-1 block break-words text-xs">
            人物判断 {entry.identityCount} 条
            {entry.identityLabels.length
              ? ` · 本地已确认：${entry.identityLabels.join("、")}`
              : " · 身份未确认"}
          </span>
        ) : null}
      </button>
    </li>
  );
});
