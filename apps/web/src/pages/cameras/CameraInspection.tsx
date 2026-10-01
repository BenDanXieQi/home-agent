import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { useFrameViewer } from "../../modules/perception/use-frame-viewer";

export function CameraInspection({
  inspect,
  inspection,
  watching,
}: Pick<
  ReturnType<typeof useFrameViewer>,
  "inspect" | "inspection" | "watching"
>) {
  const [expanded, setExpanded] = useState(true);
  return (
    <details
      className="group/inspection min-w-0 rounded-2xl bg-surface p-1.5"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-[10px] px-2 py-1.5 text-[13px] font-medium text-ink hover:bg-surface focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="shrink-0 group-open/inspection:rotate-90"
        />
        <span>调试数据</span>
        <span className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-[11px] font-normal leading-4 text-muted">
          JSON
        </span>
      </summary>
      {expanded ? (
        <div className="space-y-3 px-2.5 pb-2.5 pt-1">
          <p className="text-xs leading-6 text-muted">
            包含播放状态、后台最新分析和当前画面信息。定格后固定这份数据，后台继续分析。
          </p>
          <p className="text-xs leading-6 text-muted">
            source.analysis 是后台最新分析，不一定对应当前画面；presentation
            是当前画面及其关联结果。定格会保留当时显示的画面和识别框；框来自稍早的分析时，matching
            为 carried，ageMs 记录两帧的时间差（毫秒）。
          </p>
          {watching ? (
            <LiveInspection inspect={inspect} />
          ) : (
            <InspectionJson inspection={inspection} />
          )}
        </div>
      ) : null}
    </details>
  );
}

function LiveInspection({
  inspect,
}: Pick<ReturnType<typeof useFrameViewer>, "inspect">) {
  const [inspection, setInspection] = useState<ReturnType<typeof inspect>>();
  useEffect(() => {
    const update = () => setInspection(inspect());
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [inspect]);
  return <InspectionJson inspection={inspection} />;
}

function InspectionJson({
  inspection,
}: Pick<ReturnType<typeof useFrameViewer>, "inspection">) {
  return (
    <pre
      className="max-h-96 overflow-auto rounded-xl bg-surface p-3 text-xs"
      aria-label="调试数据 JSON 内容"
    >
      {JSON.stringify(inspection, null, 2)}
    </pre>
  );
}
