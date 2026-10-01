import { twMerge } from "tailwind-merge";
import { Link, useParams } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useState } from "react";
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
            }}
          >
            返回实时
          </Button>
        </div>
      </article>
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
    </>
  );
}
