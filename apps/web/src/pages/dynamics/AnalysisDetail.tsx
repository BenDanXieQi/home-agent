import { useState } from "react";
import { LoaderCircle, Video, AudioLines, ChevronDown } from "lucide-react";
import {
  useAnalysisDetail,
  type AnalysisSummary,
} from "../../modules/dynamics/queries";
import { MarkdownAnswer } from "../../components/agent/MarkdownAnswer";
import { Notice } from "../../components/Notice";
import { formatTime } from "../../modules/presentation/time";
import { OriginalRecordingLink } from "./OriginalRecordingLink";

const stages = {
  collecting: "正在收集连续片段",
  queued: "等待分析",
  preparing: "正在读取音视频",
  analyzing: "正在分析",
  saving: "正在保存动态",
  completed: "分析完成",
  failed: "分析失败",
  expired: "媒体已过期",
  skipped: "已跳过旧媒体",
};

export function AnalysisTiming({
  entry,
}: {
  entry: Pick<AnalysisSummary, "analysisStartedAt" | "completedAt">;
}) {
  const { analysisStartedAt, completedAt } = entry;
  if (analysisStartedAt === null) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-muted">
      <span>
        开始{" "}
        <time dateTime={new Date(analysisStartedAt).toISOString()}>
          {formatTime(analysisStartedAt, "monthDayTime")}
        </time>
      </span>
      {completedAt !== null ? (
        <>
          <span>
            结论{" "}
            <time dateTime={new Date(completedAt).toISOString()}>
              {formatTime(
                completedAt,
                formatTime(analysisStartedAt, "monthDay") ===
                  formatTime(completedAt, "monthDay")
                  ? "clock"
                  : "monthDayTime",
              )}
            </time>
          </span>
          <span>
            耗时 {((completedAt - analysisStartedAt) / 1000).toFixed(1)} 秒
          </span>
        </>
      ) : null}
    </div>
  );
}

function AnalysisMedia({
  id,
  media,
}: {
  id: string;
  media: NonNullable<
    ReturnType<typeof useAnalysisDetail>["data"]
  >["media"][number];
}) {
  const [failed, setFailed] = useState(false);
  const src = `/api/dynamics/${encodeURIComponent(id)}/media/${media.index}`;
  if (failed) return <p className="text-xs text-muted">这份分析输入已释放。</p>;
  return media.kind === "video" ? (
    // Captured video does not provide a caption track.
    // oxlint-disable-next-line jsx-a11y/media-has-caption
    <video
      controls
      playsInline
      preload="metadata"
      className="max-h-96 w-full rounded-xl bg-black"
      src={src}
      onError={() => setFailed(true)}
      aria-label="本轮分析的视频"
    />
  ) : (
    // Captured audio does not provide a caption track.
    // oxlint-disable-next-line jsx-a11y/media-has-caption
    <audio
      controls
      preload="metadata"
      className="w-full"
      src={src}
      onError={() => setFailed(true)}
      aria-label="本轮分析的音频"
    />
  );
}

export function AnalysisDetail({ entry }: { entry: AnalysisSummary }) {
  const stream = useAnalysisDetail(entry.id);
  const detail = stream.data;
  const status = detail?.status ?? entry.status;
  const active = ["preparing", "analyzing", "saving"].includes(status);
  const placeholder =
    status === "preparing"
      ? "正在读取这段媒体，准备完成后开始分析。"
      : status === "skipped"
        ? "为优先处理最新媒体，本区间未进行分析。"
        : status === "analyzing" && !detail?.reasoning
          ? "正在分析音视频…"
          : null;

  return (
    <div className="grid gap-5">
      <section className="min-w-0 space-y-3" aria-label="分析媒体">
        <h3 className="flex items-center gap-2 text-[13px] font-medium">
          {entry.kind === "video" ? (
            <Video size={14} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <AudioLines size={14} strokeWidth={1.5} aria-hidden="true" />
          )}{" "}
          本轮音视频
        </h3>
        {detail?.media.length ? (
          detail.media.map((media) => (
            <AnalysisMedia key={media.index} id={entry.id} media={media} />
          ))
        ) : (
          <div className="grid min-h-40 place-items-center rounded-xl bg-surface px-4 text-xs text-muted">
            {status === "skipped" ? "本区间已跳过" : "正在准备分析媒体…"}
          </div>
        )}
        <OriginalRecordingLink entry={entry} />
      </section>
      <section className="min-w-0 space-y-3" aria-label="分析过程">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          {active ? (
            <LoaderCircle
              size={14}
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : null}
          <span>{stages[status]}</span>
          <span className="ml-auto text-xs font-normal text-muted">
            {stream.connected ? "实时更新" : "连接中"}
          </span>
        </div>
        <AnalysisTiming entry={detail ?? entry} />
        {stream.error ? <Notice tone="warning">{stream.error}</Notice> : null}
        {detail?.error ? <Notice tone="warning">{detail.error}</Notice> : null}
        {detail?.reasoning ? (
          <details
            open
            className="group/reasoning rounded-xl bg-surface px-4 py-3"
          >
            <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-xs text-muted outline-offset-4 hover:text-ink [&::-webkit-details-marker]:hidden">
              分析过程
              <ChevronDown
                size={14}
                strokeWidth={1.5}
                aria-hidden="true"
                className="shrink-0 motion-safe:transition-transform motion-safe:duration-200 group-open/reasoning:rotate-180"
              />
            </summary>
            <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">
              {detail.reasoning}
            </div>
          </details>
        ) : null}
        {detail?.reply ? (
          <div aria-label="分析输出">
            <MarkdownAnswer>{detail.reply}</MarkdownAnswer>
          </div>
        ) : placeholder ? (
          <p className="text-sm leading-7 text-muted">{placeholder}</p>
        ) : null}
      </section>
    </div>
  );
}
