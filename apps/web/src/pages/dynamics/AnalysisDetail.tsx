import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { LoaderCircle, Video, AudioLines } from "lucide-react";
import {
  useAnalysisDetail,
  type AnalysisSummary,
} from "../../modules/dynamics/queries";
import { MarkdownAnswer } from "../../components/agent/MarkdownAnswer";
import { Notice } from "../../components/Notice";

const stages = {
  collecting: "正在收集连续片段",
  queued: "等待分析",
  preparing: "正在读取音视频",
  analyzing: "正在分析",
  saving: "正在保存动态",
  completed: "分析完成",
  failed: "分析失败",
  expired: "媒体已过期",
};

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
  if (failed)
    return (
      <p className="text-xs text-muted">
        这份分析输入已释放，可通过下方入口查看原始记录。
      </p>
    );
  return media.kind === "video" ? (
    // The sampled video has no audio track.
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
  return (
    <div className="grid gap-5 border-t border-line p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="min-w-0 space-y-3" aria-label="分析媒体">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {entry.kind === "video" ? (
            <Video size={15} />
          ) : (
            <AudioLines size={15} />
          )}{" "}
          本轮音视频
        </h3>
        {detail?.media.length ? (
          detail.media.map((media) => (
            <AnalysisMedia key={media.index} id={entry.id} media={media} />
          ))
        ) : (
          <div className="grid min-h-40 place-items-center rounded-xl bg-surface text-sm text-muted">
            正在准备分析媒体…
          </div>
        )}
        <Link
          to="/cameras/$deviceId/$channel"
          params={{
            deviceId: entry.source.deviceId,
            channel: String(entry.source.channel),
          }}
          search={{
            mode: "windows",
            window: undefined,
            rangeStart: entry.startedAt,
            rangeEnd: entry.endedAt,
            activityRun: undefined,
            member: undefined,
            activityFirstAt: undefined,
            activityAt: undefined,
          }}
          className="inline-flex text-xs text-muted underline underline-offset-4"
        >
          查看原始记录与录像
        </Link>
      </section>
      <section className="min-w-0 space-y-4" aria-label="分析过程">
        <div className="flex items-center gap-2 text-sm font-medium">
          {active ? (
            <LoaderCircle
              size={15}
              className="animate-spin motion-reduce:animate-none"
            />
          ) : null}
          <span>{stages[status]}</span>
          <span className="ml-auto text-xs font-normal text-muted">
            {stream.connected ? "实时更新" : "连接中"}
          </span>
        </div>
        {stream.error ? <Notice tone="warning">{stream.error}</Notice> : null}
        {detail?.error ? <Notice tone="warning">{detail.error}</Notice> : null}
        {detail?.reasoning ? (
          <details open className="rounded-xl bg-surface p-4">
            <summary className="cursor-pointer text-xs text-muted">
              分析过程
            </summary>
            <div className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-7">
              {detail.reasoning}
            </div>
          </details>
        ) : null}
        {detail?.reply ? (
          <div aria-label="分析输出">
            <MarkdownAnswer>{detail.reply}</MarkdownAnswer>
          </div>
        ) : (
          <p className="text-sm leading-7 text-muted">
            {status === "preparing"
              ? "正在读取这段媒体，准备完成后开始分析。"
              : "等待模型返回分析内容…"}
          </p>
        )}
      </section>
    </div>
  );
}
