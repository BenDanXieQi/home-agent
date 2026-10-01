import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { useFrameViewer } from "../../modules/perception/use-frame-viewer";
import { CameraAudioAnalysis } from "./CameraAudioAnalysis";

export function CameraInspection({
  inspect,
  inspection,
  watching,
}: Pick<
  ReturnType<typeof useFrameViewer>,
  "inspect" | "inspection" | "watching"
>) {
  const [videoExpanded, setVideoExpanded] = useState(true);
  const [audioExpanded, setAudioExpanded] = useState(true);
  const [liveInspection, setLiveInspection] =
    useState<ReturnType<typeof inspect>>();
  const sampling = watching && (videoExpanded || audioExpanded);
  useEffect(() => {
    if (!sampling) return undefined;
    const update = () => setLiveInspection(inspect());
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [inspect, sampling]);
  const current = watching ? liveInspection : inspection;
  const source = current?.source;

  return (
    <>
      <InspectionPanel
        title="视频分析"
        expanded={videoExpanded}
        onExpanded={setVideoExpanded}
      >
        <VideoInspection inspection={current} />
      </InspectionPanel>
      <InspectionPanel
        title="声音分析"
        expanded={audioExpanded}
        onExpanded={setAudioExpanded}
      >
        <p className="text-xs leading-6 text-muted">
          检测声音强度和是否有人声，不识别说话内容或说话人。与视频共用定格操作，声音区间独立于视频帧。
        </p>
        {source?.audio ? (
          <>
            <CameraAudioAnalysis audio={source.audio} />
            <AudioInspectionJson audio={source.audio} />
          </>
        ) : (
          <p className="text-xs text-muted">暂无可用的声音分析数据。</p>
        )}
      </InspectionPanel>
    </>
  );
}

function VideoInspection({
  inspection,
}: Pick<ReturnType<typeof useFrameViewer>, "inspection">) {
  const source = inspection?.source;
  const video = inspection
    ? {
        ...inspection,
        source: source
          ? {
              deviceId: source.deviceId,
              channel: source.channel,
              analysis: source.analysis,
            }
          : null,
      }
    : undefined;

  return (
    <>
      <p className="text-xs leading-6 text-muted">
        播放状态、后台画面分析及当前画面的关联结果。source.analysis
        是后台最新分析，presentation 是当前画面及其关联结果；matching 为 carried
        时表示沿用稍早的框，ageMs
        为两帧时间差（毫秒）。定格后保留当时数据，后台继续分析。
      </p>
      <pre
        className="max-h-96 overflow-auto rounded-xl bg-surface p-3 text-xs"
        aria-label="视频分析 JSON 内容"
      >
        {JSON.stringify(video, null, 2)}
      </pre>
    </>
  );
}

function AudioInspectionJson({
  audio,
}: Parameters<typeof CameraAudioAnalysis>[0]) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs text-muted">
        声音原始数据 JSON
      </summary>
      {expanded ? (
        <pre
          className="mt-2 max-h-96 overflow-auto rounded-xl bg-surface p-3 text-xs"
          aria-label="声音分析 JSON 内容"
        >
          {JSON.stringify(audio, null, 2)}
        </pre>
      ) : null}
    </details>
  );
}

function InspectionPanel({
  title,
  expanded,
  onExpanded,
  children,
}: {
  title: string;
  expanded: boolean;
  onExpanded: (expanded: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      className="group/inspection min-w-0 rounded-2xl bg-surface p-1.5"
      open={expanded}
      onToggle={(event) => onExpanded(event.currentTarget.open)}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-[10px] px-2 py-1.5 text-[13px] font-medium text-ink hover:bg-surface focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="shrink-0 group-open/inspection:rotate-90"
        />
        <span>{title}</span>
      </summary>
      {expanded ? (
        <div className="space-y-3 px-2.5 pb-2.5 pt-1">{children}</div>
      ) : null}
    </details>
  );
}
