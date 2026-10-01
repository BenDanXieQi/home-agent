import { twMerge } from "tailwind-merge";
import { Link, useParams } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, Pause, Play, RefreshCw } from "lucide-react";
import { Button } from "../../components/Button";
import { buttonStyles } from "../../components/button-styles";
import { Notice, StatusNotice } from "../../components/Notice";
import {
  householdScopeEpochAtom,
  householdSyncedAtom,
} from "../../modules/household/state";
import { createPerceptionSourceState } from "../../modules/perception/source-state";
import { usePerceptionSource } from "../../modules/perception/use-perception-source";
import { useFrameViewer } from "../../modules/perception/use-frame-viewer";
import { CameraFrame } from "./MijiaPlayer";
import { CameraHeader } from "./CameraHeader";
import { PlaybackStatus } from "./PlaybackStatus";
import { PlaybackLoader } from "./PlaybackLoader";
import { playbackPresentation } from "./playback-presentation";
import { cameraTileClassName } from "./camera-styles";

export default function CameraDetailPage() {
  const { deviceId, channel } = useParams({
    from: "/account/cameras/$deviceId/$channel",
  });
  return (
    <section className="mx-auto max-w-4xl space-y-4">
      <Link
        to="/cameras"
        className={twMerge(
          `${buttonStyles.base} ${buttonStyles.ghost} -ml-2 min-h-8 gap-1 rounded-[10px] border-0 px-2 py-1.5 text-xs font-normal hover:bg-surface hover:text-ink focus-visible:outline-2`,
        )}
      >
        <ArrowLeft size={14} aria-hidden="true" /> 返回视频列表
      </Link>
      {channel === "1" || channel === "2" ? (
        <CameraDetailSource
          key={`${deviceId}:${channel}`}
          deviceId={deviceId}
          channel={channel === "1" ? 1 : 2}
        />
      ) : (
        <Notice tone="error">镜头不存在。</Notice>
      )}
    </section>
  );
}

function CameraDetailSource(
  target: Parameters<typeof createPerceptionSourceState>[0],
) {
  const [source] = useState(() => createPerceptionSourceState(target));
  const device = useAtomValue(source.deviceAtom);
  const synced = useAtomValue(householdSyncedAtom);
  const epoch = useAtomValue(householdScopeEpochAtom);
  if (synced && (!device?.camera || !device.channels.includes(target.channel)))
    return <Notice tone="warning">该视频不在当前家庭的设备清单中。</Notice>;
  if (!epoch || !device) return <StatusNotice>正在同步设备清单…</StatusNotice>;
  return <CameraDetailContent key={epoch} source={source} />;
}

function CameraDetailContent({
  source,
}: {
  source: ReturnType<typeof createPerceptionSourceState>;
}) {
  usePerceptionSource(source);
  const {
    canvas,
    view,
    snapshot,
    watching,
    ready,
    freeze,
    live: returnToLive,
    inspect,
  } = useFrameViewer(source);
  const device = useAtomValue(source.deviceAtom);
  const connected = useAtomValue(source.connectedAtom);
  const configured = useAtomValue(source.configuredAtom);
  const error = useAtomValue(source.errorAtom);
  const [inspection, setInspection] = useState<ReturnType<typeof inspect>>();
  const json = useMemo(() => JSON.stringify(inspection, null, 2), [inspection]);
  const presentation = playbackPresentation(snapshot);
  const frozen = !!view?.frozen;
  const live = watching && ready;
  const waiting = live && !view?.hasFrame && snapshot.phase !== "error";
  const label =
    device?.channels.length && device.channels.length > 1
      ? `${device.name} · 镜头 ${source.target.channel}`
      : device?.name;

  return (
    <>
      <article className={cameraTileClassName}>
        <CameraHeader title={label ?? "视频详情"}>
          <span className="text-xs text-muted">{device?.room_name}</span>
        </CameraHeader>
        <CameraFrame
          placeholder={
            view?.hasFrame
              ? null
              : !watching
                ? "画面已暂停"
                : !ready
                  ? "等待摄像头服务就绪"
                  : snapshot.phase === "error"
                    ? "暂时无法播放"
                    : "等待摄像头画面"
          }
          waiting={waiting}
          tone={live ? presentation.tone : "unknown"}
          status={frozen ? "已定格" : watching ? "未就绪" : "已暂停"}
          detail={frozen ? <p>仅保留同帧结果</p> : undefined}
          statusContent={
            live ? <PlaybackStatus snapshot={snapshot} /> : undefined
          }
          loader={<PlaybackLoader active={waiting} />}
        >
          <canvas
            ref={canvas}
            className="absolute inset-0 size-full object-contain"
            aria-label={`${label ?? "视频"} 关联帧画面`}
          />
        </CameraFrame>
        <div className="-mt-1 flex flex-wrap gap-1.5 px-1.5 pb-2.5">
          <Button
            type="button"
            className="rounded-[10px]"
            icon={<Pause size={15} />}
            disabled={!view?.hasFrame || frozen}
            onClick={() => {
              freeze();
              setInspection(inspect());
            }}
          >
            定格当前画面
          </Button>
          <Button
            type="button"
            className="rounded-[10px]"
            icon={<Play size={15} />}
            disabled={watching}
            onClick={() => {
              returnToLive();
              setInspection(undefined);
            }}
          >
            返回实时
          </Button>
        </div>
      </article>
      {!connected ? (
        <StatusNotice>
          感知结果正在同步，暂不接纳新的检测与跟踪结果。
        </StatusNotice>
      ) : !configured ? (
        <StatusNotice>
          当前视频未配置感知采集，可观看和定格；暂无检测或跟踪结果。
        </StatusNotice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {view?.failure ? (
        <Notice tone="error">无法绘制当前画面，请重新打开视频详情。</Notice>
      ) : null}
      <details
        className="group/inspection rounded-2xl bg-white p-1.5 shadow-panel"
        onToggle={(event) => {
          if (event.currentTarget.open) setInspection(inspect());
        }}
      >
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-[10px] px-2 py-1.5 text-[13px] font-medium text-ink hover:bg-surface focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            size={14}
            aria-hidden="true"
            className="shrink-0 group-open/inspection:rotate-90"
          />
          <span>帧与结果</span>
          <span className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-[11px] font-normal leading-4 text-muted">
            JSON
          </span>
        </summary>
        <div className="space-y-3 px-2.5 pb-2.5 pt-1">
          <p className="text-xs leading-6 text-muted">
            展开、刷新或定格时取样，包含来源状态、最新结果与画面关联结果，不随实时画面自动更新。
          </p>
          <Button
            type="button"
            size="small"
            icon={<RefreshCw size={14} />}
            onClick={() => setInspection(inspect())}
          >
            刷新 JSON
          </Button>
          <pre
            className="max-h-96 overflow-auto rounded-xl bg-surface p-3 text-xs"
            aria-label="帧与结果 JSON 内容"
          >
            {json}
          </pre>
        </div>
      </details>
    </>
  );
}
