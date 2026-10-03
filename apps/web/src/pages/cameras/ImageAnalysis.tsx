import { useRef, useState } from "react";
import { ChevronRight, ImagePlus, RotateCcw, Scan, X } from "lucide-react";
import { Button } from "../../components/Button";
import { BackLink } from "../../components/BackLink";
import { Notice, StatusNotice } from "../../components/Notice";
import { useImageAnalysis } from "../../modules/perception/use-image-analysis";
import { cameraTileClassName } from "./camera-styles";

const imageActions = {
  select: { label: "选择图片", icon: ImagePlus },
  replace: { label: "重新选择图片", icon: ImagePlus },
  retry: { label: "重试分析", icon: RotateCcw },
  analyze: { label: "分析图片", icon: Scan },
};

export default function ImageAnalysisPage() {
  const { image, result, pending, error, analyze, cancel, clear } =
    useImageAnalysis();
  const picker = useRef<HTMLInputElement>(null);
  const primaryAction = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(true);
  const retrying = !!image && !!error;
  const canAnalyze = !!image && !result && !pending;
  const actionKind = pending
    ? pending.action === "select" && pending.stage === "analyzing"
      ? "replace"
      : pending.action
    : retrying
      ? "retry"
      : canAnalyze
        ? "analyze"
        : image
          ? "replace"
          : "select";
  const action = imageActions[actionKind];
  const ActionIcon = action.icon;
  return (
    <section className="space-y-3" aria-labelledby="image-analysis-title">
      <BackLink activeOptions={{ exact: true }} to="/cameras" className="-ml-2">
        返回看家
      </BackLink>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <article className={`${cameraTileClassName} space-y-3 p-4`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 id="image-analysis-title" className="text-base font-semibold">
                图片分析
              </h2>
              <p className="mt-1 text-xs leading-6 text-muted">
                选择图片后自动分析，查看人体、猫狗、头部和人脸检测结果。
              </p>
            </div>
            <input
              ref={picker}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file)
                  analyze(file).catch((cause: unknown) =>
                    console.error("Image selection failed", cause),
                  );
              }}
            />
            <Button
              ref={primaryAction}
              type="button"
              variant="primary"
              className="min-w-36"
              icon={<ActionIcon size={15} />}
              status={pending ? "pending" : "idle"}
              pendingAction={{ label: "取消等待", onClick: cancel }}
              onClick={() => {
                if (canAnalyze) {
                  analyze().catch((cause: unknown) =>
                    console.error("Image analysis failed", cause),
                  );
                } else picker.current?.click();
              }}
            >
              {action.label}
            </Button>
          </div>
          <p className="text-xs leading-6 text-muted">
            最多 32 MiB，每边最多 8192 像素，总像素不超过 3840 ×
            2160。预览为实际提交图片，按图片方向处理，透明区域使用白色背景。
          </p>
          {pending ? (
            <StatusNotice>
              {pending.stage === "preparing"
                ? "正在准备图片…"
                : "正在上传并等待检测结果，首次使用需准备模型…"}
            </StatusNotice>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          {image ? (
            <>
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 break-all text-xs text-muted">
                  {image.name} · {image.width} × {image.height}
                  {result
                    ? ` · 检出 ${result.detections.length} 个目标`
                    : " · 尚无检测结果"}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  icon={<X size={15} />}
                  aria-label="清除图片与结果"
                  title="清除图片与结果"
                  onClick={() => {
                    clear();
                    primaryAction.current?.focus();
                  }}
                />
              </div>
              <div className="relative w-full overflow-hidden rounded-xl bg-surface">
                <img
                  src={image.url}
                  alt={`${image.name} · 实际提交图片预览`}
                  width={image.width}
                  height={image.height}
                  className="block h-auto max-h-[65dvh] w-full object-contain"
                />
                {result ? (
                  <svg
                    viewBox={`0 0 ${result.width} ${result.height}`}
                    className="pointer-events-none absolute inset-0 size-full"
                    preserveAspectRatio="xMidYMid meet"
                    aria-hidden="true"
                  >
                    {result.detections.map((detection, index) => (
                      <g key={index}>
                        <rect
                          x={detection.x}
                          y={detection.y}
                          width={detection.w}
                          height={detection.h}
                          fill="none"
                          stroke="#00a87c"
                          strokeWidth={2}
                          vectorEffect="non-scaling-stroke"
                        />
                        <text
                          x={detection.x}
                          y={Math.max(
                            18,
                            result.width / 55 + 4,
                            detection.y - 6,
                          )}
                          fontSize={Math.max(14, result.width / 55)}
                          fill="#00a87c"
                          stroke="white"
                          strokeWidth={3}
                          paintOrder="stroke"
                          strokeLinejoin="round"
                        >
                          {detection.className}{" "}
                          {Math.round(detection.confidence * 100)}%
                        </text>
                      </g>
                    ))}
                  </svg>
                ) : null}
              </div>
            </>
          ) : !pending ? (
            <div className="rounded-xl bg-surface px-4 py-16 text-center text-sm text-muted">
              选择图片后显示预览
            </div>
          ) : null}
        </article>
        <details
          className="group/inspection min-w-0 rounded-2xl bg-surface p-1.5"
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-[10px] px-2 py-1.5 text-[13px] font-medium text-ink hover:bg-surface focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              size={14}
              aria-hidden="true"
              className="group-open/inspection:rotate-90"
            />{" "}
            检测结果
            <span className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted">
              JSON
            </span>
          </summary>
          {expanded ? (
            result ? (
              <pre
                className="max-h-96 overflow-auto rounded-xl bg-surface p-3 text-xs"
                aria-label="图片检测结果 JSON 内容"
              >
                {JSON.stringify(result, null, 2)}
              </pre>
            ) : (
              <p className="px-2.5 pb-2.5 text-xs leading-6 text-muted">
                分析完成后显示本次图片的完整检测结果。
              </p>
            )
          ) : null}
        </details>
      </div>
    </section>
  );
}
