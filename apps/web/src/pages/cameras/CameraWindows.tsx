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
  windowQueryScope,
  windowRequestUnavailable,
  type WindowListEntry,
} from "../../modules/perception/windows";
import { useWindowMediaState } from "../../modules/perception/use-window-input-state";
import { windowTime, mediaStates, candidateLabel } from "./window-presentation";
import { CameraHeader } from "./CameraHeader";
import { cameraTileClassName } from "./camera-styles";
import { useWindowDetail } from "../../modules/perception/use-window-detail";
import { WindowMedia } from "./WindowMedia";
import { WindowDetail } from "./WindowDetail";

export function CameraWindows({
  source,
  scope,
  visible,
}: {
  source: ReturnType<typeof createPerceptionSourceState>;
  scope: string;
  visible: boolean;
}) {
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
  const query = useQuery({
    ...windowListOptions({ scopeEpoch: scope, ...source.target }),
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
  const [visibleCount, setVisibleCount] = useState(50);
  if (!selection && active && !query.isError) {
    const playable = query.data?.windows.filter(
      (entry) =>
        entry.sampledMedia?.state === "ready" &&
        entry.sampledMedia.readableUntil > query.dataUpdatedAt,
    );
    if (playable?.length === 1) select(playable[0]);
  }
  const windows = query.data?.windows ?? [];
  const selected =
    windows.find((entry) => entry.id === selection?.id) ?? selection;
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
              <span className="text-xs text-muted">最多保留 30 分钟</span>
            </div>
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
                {windows.slice(0, visibleCount).map((entry) => (
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
                      onClick={() => setVisibleCount((count) => count + 50)}
                    >
                      显示更早的片段
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
                        : windows.length
                          ? "选择片段"
                          : "暂无片段"
                }
                description={
                  selected?.gate.candidate === "none"
                    ? "此片段没有可回放的画面，可在详情中查看语音文字。"
                    : windows.length
                      ? "选择列表中的片段查看内容。"
                      : "检测到画面变化或识别出说话内容后，片段会自动出现在这里。"
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
            {windowTime(entry.startedAt)} – {windowTime(entry.endedAt)}
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
          {entry.gate.candidate === "none"
            ? "仅文字"
            : state
              ? mediaStates[state]
              : "尚未生成"}
          {entry.incomplete ? " · 不完整窗口" : ""}
        </span>
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
