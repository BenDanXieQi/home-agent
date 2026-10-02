import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Button } from "../../components/Button";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import type { createPerceptionSourceState } from "../../modules/perception/source-state";
import {
  recordingIndexOptions,
  type RecordingTarget,
} from "../../modules/recordings/api";
import { RecordingPlayer } from "../../modules/recordings/RecordingPlayer";
import { useRecordingPlayback } from "../../modules/recordings/use-recording-playback";
import {
  recordingDuration,
  recordingIndexUnavailableText,
  recordingTime,
} from "../../modules/recordings/presentation";

export function CameraRecordings({
  source,
}: {
  source: ReturnType<typeof createPerceptionSourceState>;
}) {
  const target = useAtomValue(source.playbackTargetAtom);
  const device = useAtomValue(source.deviceAtom);
  return target ? (
    <RecordingBrowser
      key={`${target.scope_epoch}:${target.revision}`}
      target={target}
      label={`${device?.name ?? "摄像头"} · 镜头 ${source.target.channel}`}
    />
  ) : (
    <StatusNotice>等待当前家庭与摄像头连接就绪后读取 SD 录像。</StatusNotice>
  );
}

function localDay() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function RecordingBrowser({
  target,
  label,
}: {
  target: RecordingTarget;
  label: string;
}) {
  const [day, setDay] = useState(localDay);
  const from = new Date(`${day}T00:00:00`).getTime();
  const nextDay = new Date(from);
  nextDay.setDate(nextDay.getDate() + 1);
  const until = nextDay.getTime();
  const validDay = Number.isFinite(from) && from >= 0;
  const query = useInfiniteQuery({
    ...recordingIndexOptions(
      target,
      validDay ? Math.max(0, from - 1) : 0,
      validDay ? until : 0,
    ),
    enabled: validDay,
  });
  const recordings =
    query.data?.pages.flatMap((page) =>
      page.status === "ready"
        ? page.recordings.filter(
            (clip) => clip.startAt >= from && clip.startAt < until,
          )
        : [],
    ) ?? [];
  const unavailable = query.data?.pages.find(
    (page) => page.status === "unavailable",
  );
  const playback = useRecordingPlayback(target);
  const selected =
    playback.request?.selection.kind === "clip"
      ? playback.request.selection.startAt
      : null;
  return (
    <section aria-label="摄像头 SD 录像" className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">{label}</h2>
        <p className="mt-1 text-sm font-medium">SD 录像</p>
        <p className="mt-1 text-sm leading-6 text-muted">
          时间由摄像头报告，按本机时区显示；与本机接收时间可能存在偏差。选择一段录像后可播放完整内容并拖动进度。
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          <span>录像日期</span>
          <input
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
            className="rounded-lg border border-line bg-surface px-3 py-2"
          />
        </label>
        <Button
          disabled={!validDay || query.isFetching}
          onClick={() => {
            // refetch owns failures and exposes them through query.error.
            // oxlint-disable-next-line typescript/no-floating-promises
            query.refetch();
          }}
        >
          刷新录像清单
        </Button>
      </div>
      {!validDay ? (
        <StatusNotice>请选择要查看的录像日期。</StatusNotice>
      ) : query.isPending ? (
        <StatusNotice>正在读取 SD 录像清单…</StatusNotice>
      ) : null}
      {query.isError ? (
        <Notice tone="error">
          录像清单读取失败：{requestErrorMessage(query.error)}
        </Notice>
      ) : null}
      {unavailable ? (
        <Notice tone="warning">
          {recordingIndexUnavailableText[unavailable.reason]}
        </Notice>
      ) : null}
      {validDay &&
      !query.isPending &&
      !query.isError &&
      !unavailable &&
      recordings.length === 0 ? (
        <StatusNotice>这一天暂无摄像头报告的录像。</StatusNotice>
      ) : null}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)]">
        <div className="space-y-3">
          <ul
            aria-label="SD 录像片段"
            className="max-h-[65dvh] space-y-2 overflow-y-auto"
          >
            {recordings.map((clip) => (
              <li key={clip.startAt}>
                <button
                  type="button"
                  aria-pressed={selected === clip.startAt}
                  className="w-full rounded-xl border border-line bg-surface p-3 text-left text-sm hover:bg-ink/5 focus-visible:outline-2 aria-pressed:border-ink"
                  onClick={() => {
                    if (
                      selected === clip.startAt &&
                      !playback.expired &&
                      (playback.pending ||
                        playback.state?.state === "preparing" ||
                        playback.state?.state === "ready")
                    )
                      return;
                    playback.start({ kind: "clip", startAt: clip.startAt });
                  }}
                >
                  <span className="block font-medium">
                    {recordingTime(clip.startAt)}
                  </span>
                  <span className="mt-1 block text-xs text-muted">
                    {recordingDuration(clip.endAt - clip.startAt)}
                    {clip.event ? " · 摄像头事件标记" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {query.hasNextPage ? (
            <Button
              disabled={query.isFetching}
              onClick={() => {
                // Pagination failures remain available through query.error.
                // oxlint-disable-next-line typescript/no-floating-promises
                query.fetchNextPage();
              }}
            >
              读取更多录像
            </Button>
          ) : null}
        </div>
        <div className="min-w-0 rounded-2xl border border-line p-4">
          {playback.request ? (
            <RecordingPlayer playback={playback} />
          ) : (
            <StatusNotice>选择一段 SD 录像。</StatusNotice>
          )}
        </div>
      </div>
    </section>
  );
}
