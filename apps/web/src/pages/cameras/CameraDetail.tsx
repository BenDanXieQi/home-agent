import { CameraAnalysisLayout } from "./CameraAnalysisLayout";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "../../components/Button";
import { BackLink } from "../../components/BackLink";
import { Notice, StatusNotice } from "../../components/Notice";
import {
  householdScopeEpochAtom,
  householdSyncedAtom,
} from "../../modules/household/state";
import { createPerceptionSourceState } from "../../modules/perception/source-state";
import { useFrameViewer } from "../../modules/perception/use-frame-viewer";
import { CameraFrame } from "./MijiaPlayer";
import { CameraIdentity } from "./CameraIdentity";
import { CameraInspection } from "./CameraInspection";
import { CameraHeader } from "./CameraHeader";
import { PlaybackStatus } from "./PlaybackStatus";
import { PlaybackLoader } from "./PlaybackLoader";
import { playbackPresentation } from "./playback-presentation";
import { cameraTileClassName, cameraTransitionName } from "./camera-styles";
import { useCameraReturn } from "./use-camera-return";
import { createCameraAspectAtom } from "../../modules/playback/media-aspect";
import { CameraWindows } from "./CameraWindows";

function CameraDetailBackLink() {
  const { member } = useSearch({
    from: "/account/cameras/$deviceId/$channel",
  });
  return member ? (
    <BackLink to="/members" search={{ member }} className="-ml-2">
      返回成员
    </BackLink>
  ) : (
    <BackLink activeOptions={{ exact: true }} to="/cameras" className="-ml-2">
      返回看家
    </BackLink>
  );
}

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
          <CameraDetailBackLink />
          <Notice tone="error">镜头不存在。</Notice>
        </>
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
    return (
      <>
        <CameraDetailBackLink />
        <Notice tone="warning">该视频不在当前家庭的设备清单中。</Notice>
      </>
    );
  if (!epoch || !device)
    return (
      <>
        <CameraDetailBackLink />
        <StatusNotice>正在同步设备清单…</StatusNotice>
      </>
    );
  return <CameraDetailModes key={epoch} source={source} scope={epoch} />;
}

function CameraDetailModes({
  source,
  scope,
}: {
  source: ReturnType<typeof createPerceptionSourceState>;
  scope: string;
}) {
  const {
    mode,
    activityRun,
    activityFirstAt,
    activityAt,
    member,
    window: windowId,
  } = useSearch({
    from: "/account/cameras/$deviceId/$channel",
  });
  const [windowsVisited, setWindowsVisited] = useState(mode === "windows");
  if (mode === "windows" && !windowsVisited) setWindowsVisited(true);
  const header = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CameraDetailBackLink />
        <nav
          aria-label="分析内容"
          className="inline-flex rounded-[10px] bg-surface p-0.5"
        >
          {([undefined, "windows"] as const).map((value) => (
            <Link
              key={value ?? "live"}
              to="/cameras/$deviceId/$channel"
              params={{
                deviceId: source.target.deviceId,
                channel: String(source.target.channel),
              }}
              search={{
                mode: value,
                window: undefined,
                activityRun: undefined,
                activityAt: undefined,
                activityFirstAt: undefined,
                member,
              }}
              activeOptions={{ exact: true }}
              className="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:text-ink focus-visible:outline-2 aria-[current=page]:bg-ink/5 aria-[current=page]:font-medium aria-[current=page]:text-ink"
            >
              {value === "windows" ? "筛选片段" : "实时检测"}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
  return (
    <div className="space-y-4">
      {header}
      {windowsVisited ? (
        <div hidden={mode !== "windows"}>
          <CameraWindows
            key={`${windowId ?? ""}:${activityRun ?? ""}:${activityFirstAt ?? ""}:${activityAt ?? ""}`}
            source={source}
            scope={scope}
            visible={mode === "windows"}
          />
        </div>
      ) : null}
      {mode !== "windows" ? <CameraDetailContent source={source} /> : null}
    </div>
  );
}

export function CameraDetailContent({
  source,
  renderControls,
}: {
  source: ReturnType<typeof createPerceptionSourceState>;
  renderControls?: (
    inspect: ReturnType<typeof useFrameViewer>["inspect"],
  ) => ReactNode;
}) {
  const {
    canvas,
    view,
    snapshot,
    watching,
    ready,
    freeze,
    retry,
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
  const failed = watching && snapshot.phase === "error";
  const live = watching && ready;
  const waiting = live && !view?.hasFrame && snapshot.phase !== "error";
  const label =
    device?.channels.length && device.channels.length > 1
      ? `${device.name} · 镜头 ${source.target.channel}`
      : device?.name;

  return (
    <CameraAnalysisLayout
      sidebarLabel="画面分析数据"
      sidebar={
        <>
          {!connected ? (
            <StatusNotice>正在连接分析结果…</StatusNotice>
          ) : !configured ? (
            <StatusNotice>
              当前视频暂无分析结果，可继续观看和定格。
            </StatusNotice>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          {view?.failure ? (
            <Notice tone="error">无法绘制当前画面，请重新打开视频详情。</Notice>
          ) : null}
          <CameraIdentity source={source} frozen={frozen} />
          <CameraInspection
            inspect={inspect}
            inspection={inspection}
            watching={watching}
          />
        </>
      }
    >
      <article
        className={`${cameraTileClassName} [&_.camera-surface]:max-h-[65dvh]`}
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
              icon={
                failed ? (
                  <RotateCcw size={15} />
                ) : watching ? (
                  <Pause size={15} />
                ) : (
                  <Play size={15} />
                )
              }
              disabled={watching && !failed && (!view?.hasFrame || frozen)}
              onClick={() => {
                if (failed) retry();
                else if (watching) freeze();
                else returnToLive();
              }}
            >
              {failed ? "重新播放" : watching ? "定格当前画面" : "返回实时"}
            </Button>
          }
        >
          <canvas
            ref={canvas}
            className="absolute inset-0 size-full object-contain"
            aria-label={`${label ?? "视频"} 关联帧画面`}
          />
        </CameraFrame>
        {renderControls?.(inspect)}
      </article>
    </CameraAnalysisLayout>
  );
}
