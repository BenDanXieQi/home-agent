import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import type { RecordingPlaybackState } from "./api";
import type { useRecordingPlayback } from "./use-recording-playback";
import {
  recordingDuration,
  recordingTime,
  recordingUnavailableText,
} from "./presentation";

export function RecordingPlayer({
  playback,
  activityAt,
  autoPlay = false,
}: {
  playback: ReturnType<typeof useRecordingPlayback>;
  activityAt?: number | undefined;
  autoPlay?: boolean;
}) {
  const { state, request, expired } = playback;
  if (!request) return null;
  return (
    <section aria-label="SD 录像回看" className="space-y-3">
      <h3 className="font-medium">SD 录像回看</h3>
      {!expired && state?.state === "ready" ? (
        <ReadyRecording
          key={state.id}
          resource={state}
          refresh={playback.refresh}
          activityAt={activityAt}
          autoPlay={autoPlay}
        />
      ) : (
        <RecordingSurface>
          <output className="max-h-full overflow-auto p-4 text-center text-sm text-white/70">
            {expired || state?.state === "expired"
              ? "本次回看已到保留期限，请重新申请。"
              : state?.state === "revoked"
                ? "这段录像的访问资格已失效。"
                : state?.state === "unavailable"
                  ? recordingUnavailableText[state.reason]
                  : playback.error
                    ? "录像暂时无法读取，请重试。"
                    : "正在从摄像头准备录像…"}
          </output>
        </RecordingSurface>
      )}
      {playback.error ? (
        <Notice tone="error">
          录像状态读取失败：{requestErrorMessage(playback.error)}
          <Button
            size="small"
            onClick={() => {
              // refetch owns failures and exposes them through playback.error.
              // oxlint-disable-next-line typescript/no-floating-promises
              playback.refresh();
            }}
          >
            重新读取状态
          </Button>
        </Notice>
      ) : null}
    </section>
  );
}

function RecordingSurface({ children }: { children: ReactNode }) {
  return (
    <div className="grid aspect-video max-h-[65dvh] place-items-center overflow-hidden rounded-xl bg-black">
      {children}
    </div>
  );
}

function ReadyRecording({
  resource,
  refresh,
  activityAt,
  autoPlay,
}: {
  resource: Extract<RecordingPlaybackState, { state: "ready" }>;
  activityAt?: number | undefined;
  autoPlay: boolean;
  refresh: ReturnType<typeof useRecordingPlayback>["refresh"];
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const alignment = resource.alignment;
  const activitySegment =
    activityAt === undefined
      ? undefined
      : resource.segments.find(
          (item) => item.startAt <= activityAt && activityAt < item.endAt,
        );
  const activityOffset =
    activitySegment && activityAt !== undefined
      ? activitySegment.mediaStartMs +
        ((activityAt - activitySegment.startAt) *
          (activitySegment.mediaEndMs - activitySegment.mediaStartMs)) /
          (activitySegment.endAt - activitySegment.startAt)
      : undefined;
  useEffect(() => {
    const node = video.current;
    if (!node) return undefined;
    node.src = resource.fileUrl;
    return () => {
      node.pause();
      node.removeAttribute("src");
      node.load();
    };
  }, [resource.fileUrl]);

  function seek(offsetMs: number) {
    const node = video.current;
    if (!node || node.readyState < 1) return;
    const seconds = offsetMs / 1000;
    if (!Number.isFinite(node.duration) || seconds >= node.duration) {
      setFailure("录像时长与定位信息不一致，暂不能定位；可手动播放。");
      return;
    }
    try {
      node.currentTime = seconds;
    } catch {
      setFailure("浏览器暂不能跳到该位置，可手动拖动播放进度。");
    }
  }

  return (
    <div className="space-y-3">
      <RecordingSurface>
        {/* Camera recordings have no verified transcript; do not invent captions. */}
        {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={video}
          controls
          autoPlay={autoPlay}
          muted={autoPlay}
          playsInline
          preload="metadata"
          aria-label="摄像头 SD 录像"
          className="size-full object-contain"
          onLoadedMetadata={() => {
            if (activityOffset !== undefined) seek(activityOffset);
            else if (alignment.type === "confirmed")
              seek(alignment.seekOffsetMs);
          }}
          onError={() => {
            setFailure(
              "录像读取或解码失败，可能已过期、连接中断或浏览器不支持当前编码。",
            );
            // refetch owns request failures and reports the current resource state.
            // oxlint-disable-next-line typescript/no-floating-promises
            refresh();
          }}
        />
      </RecordingSurface>
      <p className="text-xs leading-5 text-muted">
        来源：摄像头 SD 卡 · 录像长度{" "}
        {recordingDuration(resource.actualDurationMs)}
        {" · "}本次回看保留至 {recordingTime(resource.expiresAt)}
      </p>
      {failure ? <Notice tone="error">{failure}</Notice> : null}
      {activityAt !== undefined ? (
        <p className="text-xs text-muted">
          {activityOffset !== undefined
            ? "已按摄像头录像时间定位到活动时刻；画面与识别采样尚未经逐帧核对。"
            : "录像未覆盖活动时间，请返回成员重新查看。"}
        </p>
      ) : alignment.type === "confirmed" ? (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            事件位置已对齐。 对齐误差范围 ±{Math.ceil(alignment.uncertaintyMs)}{" "}
            毫秒。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="small" onClick={() => seek(alignment.seekOffsetMs)}>
              定位到事件
            </Button>
            {resource.eventFrameOffsets.map((frame) => (
              <Button
                key={frame.sequence}
                size="small"
                onClick={() => seek(frame.offsetMs)}
              >
                保留帧 {frame.sequence}
              </Button>
            ))}
          </div>
        </div>
      ) : alignment.reason === "clip_selected" ? (
        <p className="text-xs text-muted">
          从所选录像开头播放，可拖动进度查看。
        </p>
      ) : alignment.reason === "resolution_mismatch" ? (
        <Notice tone="warning">
          观察画面与 SD
          原录像的分辨率不同，无法精确定位这条记录。可手动查看附近录像；提高后续采集画质不会补齐这条旧记录的原始画面。
        </Notice>
      ) : (
        <Notice tone="warning">
          这是附近时段的候选录像，事件位置尚未对齐。请手动查看；窗口的本机接收时间不代表录像中的准确位置。
        </Notice>
      )}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer rounded py-1 focus-visible:outline-2">
          录像时段与缺口 · {resource.segments.length} 段
        </summary>
        <p className="mt-2 leading-5">
          以下为设备报告时间，按本机时区显示；其准确性未经时钟校准确认。
        </p>
        <ol className="mt-2 space-y-2">
          {resource.segments.map((segment, index) => (
            <li key={`${index}:${segment.startAt}`}>
              {segment.gapBeforeMs > 0 ? (
                <p className="text-amber-700">
                  此前缺少 {recordingDuration(segment.gapBeforeMs)} 录像
                </p>
              ) : null}
              <p>
                {recordingTime(segment.startAt)} –{" "}
                {recordingTime(segment.endAt)}
              </p>
              <p>
                播放位置 {recordingDuration(segment.mediaStartMs)} –{" "}
                {recordingDuration(segment.mediaEndMs)}
              </p>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
