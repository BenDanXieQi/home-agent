import { twMerge } from "tailwind-merge";
import { Link, useParams } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Pause, Play } from "lucide-react";
import { Button } from "../../components/Button";
import { buttonStyles } from "../../components/button-styles";
import { Notice, StatusNotice } from "../../components/Notice";
import {
  householdScopeEpochAtom,
  householdSyncedAtom,
} from "../../modules/household/state";
import { createPerceptionSourceState } from "../../modules/perception/source-state";
import { useFrameViewer } from "../../modules/perception/use-frame-viewer";
import { CameraFrame } from "./MijiaPlayer";
import { CameraInspection } from "./CameraInspection";
import { CameraHeader } from "./CameraHeader";
import { PlaybackStatus } from "./PlaybackStatus";
import { PlaybackLoader } from "./PlaybackLoader";
import { playbackPresentation } from "./playback-presentation";
import { cameraTileClassName, cameraTransitionName } from "./camera-styles";
import { useCameraReturn } from "./use-camera-return";
import { createCameraAspectAtom } from "../../modules/playback/media-aspect";

export default function CameraDetailPage() {
  useCameraReturn();
  const { deviceId, channel } = useParams({
    from: "/account/cameras/$deviceId/$channel",
  });
  return (
    <section className="space-y-3">
      {channel === "1" || channel === "2" ? (
        <CameraDetailSource
          key={`${deviceId}:${channel}`}
          deviceId={deviceId}
          channel={channel === "1" ? 1 : 2}
        />
      ) : (
        <>
          <CameraBackLink />
          <Notice tone="error">镜头不存在。</Notice>
        </>
      )}
    </section>
  );
}

function CameraBackLink() {
  return (
    <Link
      to="/cameras"
      className={twMerge(
        `${buttonStyles.base} ${buttonStyles.ghost} -ml-2 min-h-8 justify-self-start gap-1 rounded-[10px] border-0 px-2 py-1.5 text-xs font-normal hover:bg-surface hover:text-ink focus-visible:outline-2`,
      )}
    >
      <ArrowLeft size={14} aria-hidden="true" /> 返回
    </Link>
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
    return (
      <>
        <CameraBackLink />
        <Notice tone="warning">该视频不在当前家庭的设备清单中。</Notice>
      </>
    );
  if (!epoch || !device)
    return (
      <>
        <CameraBackLink />
        <StatusNotice>正在同步设备清单…</StatusNotice>
      </>
    );
  return <CameraDetailContent key={epoch} source={source} />;
}

function CameraDetailContent({
  source,
}: {
  source: ReturnType<typeof createPerceptionSourceState>;
}) {
  const {
    canvas,
    view,
    snapshot,
    watching,
    ready,
    freeze,
    live: returnToLive,
    inspection,
    inspect,
  } = useFrameViewer(source);
  const aspectAtom = useMemo(
    () => createCameraAspectAtom(source.target.deviceId, source.target.channel),
    [source.target.deviceId, source.target.channel],
  );
  const [aspectRatio, setAspectRatio] = useAtom(aspectAtom);
  useEffect(() => {
    if (view?.aspectRatio) setAspectRatio(view.aspectRatio);
  }, [view?.aspectRatio, setAspectRatio]);
  const device = useAtomValue(source.deviceAtom);
  const connected = useAtomValue(source.connectedAtom);
  const configured = useAtomValue(source.configuredAtom);
  const error = useAtomValue(source.errorAtom);
  const presentation = playbackPresentation(snapshot);
  const frozen = !!view?.frozen;
  const live = watching && ready;
  const waiting = live && !view?.hasFrame && snapshot.phase !== "error";
  const label =
    device?.channels.length && device.channels.length > 1
      ? `${device.name} · 镜头 ${source.target.channel}`
      : device?.name;

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div className="grid min-w-0 gap-3 xl:sticky xl:top-[calc(var(--workspace-header-height)+1rem)] xl:max-h-[calc(100dvh-var(--workspace-header-height)-2rem)] xl:grid-rows-[auto_minmax(0,1fr)]">
        <CameraBackLink />
        <article
          className={`${cameraTileClassName} xl:grid xl:min-h-0 xl:grid-rows-[auto_minmax(0,1fr)_auto] [&_.camera-surface]:max-h-[65dvh] xl:[&_.camera-surface]:min-h-0 xl:[&_.camera-surface]:max-h-[min(65dvh,100%)]`}
        >
          <CameraHeader
            title={label ?? "视频详情"}
            className="min-h-12 pr-4 py-2"
          >
            <span className="text-xs text-muted">{device?.room_name}</span>
          </CameraHeader>
          <CameraFrame
            aspectRatio={aspectRatio}
            transitionName={cameraTransitionName(
              source.target.deviceId,
              source.target.channel,
            )}
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
            detail={frozen ? <p>画面与调试数据已固定</p> : undefined}
            statusContent={
              live ? <PlaybackStatus snapshot={snapshot} /> : undefined
            }
            loader={<PlaybackLoader active={waiting} />}
            statusAction={
              <Button
                type="button"
                className="min-w-36 rounded-[10px]"
                icon={watching ? <Pause size={15} /> : <Play size={15} />}
                disabled={watching && (!view?.hasFrame || frozen)}
                onClick={() => {
                  if (watching) freeze();
                  else returnToLive();
                }}
              >
                {watching ? "定格当前画面" : "返回实时"}
              </Button>
            }
          >
            <canvas
              ref={canvas}
              className="absolute inset-0 size-full object-contain"
              aria-label={`${label ?? "视频"} 关联帧画面`}
            />
          </CameraFrame>
        </article>
      </div>
      <aside className="min-w-0 space-y-3" aria-label="画面分析数据">
        {!connected ? (
          <StatusNotice>正在连接分析结果…</StatusNotice>
        ) : !configured ? (
          <StatusNotice>当前视频暂无分析结果，可继续观看和定格。</StatusNotice>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {view?.failure ? (
          <Notice tone="error">无法绘制当前画面，请重新打开视频详情。</Notice>
        ) : null}
        <CameraInspection
          inspect={inspect}
          inspection={inspection}
          watching={watching}
        />
      </aside>
    </div>
  );
}
