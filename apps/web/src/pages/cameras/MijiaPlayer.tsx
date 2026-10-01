import { Link } from "@tanstack/react-router";
import { CameraHeader } from "./CameraHeader";
import { twMerge } from "tailwind-merge";
import { Maximize, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "../../components/Button";
import { useEffect, useMemo, type ReactNode } from "react";
import { useAtom } from "jotai";
import { AnimatePresence, m } from "motion/react";
import { contentSwap } from "../../utils/motion";
import { useMijiaPlayback } from "../../modules/playback/use-mijia-playback";
import {
  playbackPresentation,
  playbackBadgeTones,
} from "./playback-presentation";
import { PlaybackLoader } from "./PlaybackLoader";
import { PlaybackStatus } from "./PlaybackStatus";
import { buttonStyles } from "../../components/button-styles";
import { cameraTransitionName } from "./camera-styles";
import { createCameraAspectAtom } from "../../modules/playback/media-aspect";

/**
 * Surface and status row shared by every tile state, so switching between
 * waiting, playing, paused and failed never changes the tile's height.
 */
export function CameraFrame({
  children,
  placeholder,
  waiting = false,
  tone,
  status,
  detail,
  notice,
  statusAction,
  statusContent,
  loader,
  transitionName,
  aspectRatio = 16 / 9,
}: {
  children?: ReactNode;
  placeholder: string | null;
  waiting?: boolean;
  tone: keyof typeof playbackBadgeTones;
  status: string;
  detail?: ReactNode;
  notice?: ReactNode;
  statusAction?: ReactNode;
  statusContent?: ReactNode;
  loader?: ReactNode;
  transitionName?: string;
  aspectRatio?: number;
}) {
  return (
    <>
      <div
        className="camera-surface relative grid aspect-video w-full place-items-center bg-[#111111] [container-type:size] [view-transition-class:camera-background] [&_video]:block [&_video]:size-full [&_video]:object-contain"
        style={{
          viewTransitionName: transitionName
            ? `${transitionName}-background`
            : undefined,
        }}
      >
        <div
          className="relative [view-transition-class:camera]"
          style={{
            viewTransitionName: transitionName,
            width: `min(100cqw, calc(100cqh * ${aspectRatio}))`,
            height: `min(100cqh, calc(100cqw / ${aspectRatio}))`,
          }}
        >
          {children}
        </div>
        {/* The first frame is revealed by fading the placeholder, not by a cut. */}
        <AnimatePresence initial={false}>
          {placeholder !== null ? (
            <m.div
              key="placeholder"
              className="absolute inset-0 grid place-items-center bg-[#111111] px-4 text-center text-xs text-white/70"
              exit={{ opacity: 0, transition: { duration: 0.24 } }}
            >
              {waiting ? (
                <>
                  {loader}
                  <span className="sr-only">{placeholder}</span>
                </>
              ) : (
                <AnimatePresence mode="popLayout" initial={false}>
                  <m.span key={placeholder} {...contentSwap}>
                    {placeholder}
                  </m.span>
                </AnimatePresence>
              )}
            </m.div>
          ) : null}
        </AnimatePresence>
        {notice ? (
          <output className="absolute top-2 left-2 rounded bg-black/60 px-2 py-1 text-[11px] text-white/90">
            {notice}
          </output>
        ) : null}
      </div>
      <div
        className="[&[data-waiting='true']_.status-dot]:animate-[camera-wait-pulse_2.4s_ease-in-out_infinite] motion-reduce:[&[data-waiting='true']_.status-dot]:animate-none flex min-h-10 items-center gap-3 overflow-hidden bg-white px-1.5 py-1.5 text-muted [&_.status-badge]:shrink-0 [&_.status-badge]:whitespace-nowrap [&_p]:min-w-0 [&_p]:flex-1 [&_p]:truncate [&_p]:text-[11px]"
        data-waiting={waiting}
      >
        {statusContent ?? (
          <>
            <span
              className={twMerge(
                `status-badge inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] ${playbackBadgeTones[tone]}`,
              )}
            >
              <span
                className="status-dot size-1.5 rounded-full bg-current"
                aria-hidden="true"
              />
              {status}
            </span>
            {detail}
          </>
        )}
        {statusAction ? (
          <span className="my-1 ml-auto inline-flex shrink-0">
            {statusAction}
          </span>
        ) : null}
      </div>
    </>
  );
}

export function MijiaPlayer({
  revision,
  scope_epoch,
  deviceId,
  channel,
  name,
  enabled,
  active,
  onEnabledChange,
  notice,
  statusAction,
  expanded = false,
}: NonNullable<Parameters<typeof useMijiaPlayback>[0]> & {
  name: string;
  notice?: ReactNode;
  statusAction?: ReactNode;
  enabled: boolean;
  active: boolean;
  onEnabledChange: (enabled: boolean) => void;
  expanded?: boolean;
}) {
  const { videoRef, snapshot, restart } = useMijiaPlayback(
    enabled && active ? { revision, scope_epoch, deviceId, channel } : null,
  );
  const aspectAtom = useMemo(
    () => createCameraAspectAtom(deviceId, channel),
    [deviceId, channel],
  );
  const [aspectRatio, setAspectRatio] = useAtom(aspectAtom);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const recordRatio = () => {
      if (video.videoWidth && video.videoHeight)
        setAspectRatio(video.videoWidth / video.videoHeight);
    };
    video.addEventListener("loadedmetadata", recordRatio);
    video.addEventListener("resize", recordRatio);
    recordRatio();
    return () => {
      video.removeEventListener("loadedmetadata", recordRatio);
      video.removeEventListener("resize", recordRatio);
    };
  }, [videoRef, setAspectRatio]);
  const presentation = playbackPresentation(snapshot);
  const playing = enabled && active;
  return (
    <div
      className={expanded ? "flex h-full min-h-0 flex-col" : "relative"}
      aria-label={`${name} 视频预览`}
    >
      <CameraHeader title={name}>
        <div className="flex gap-1 relative shrink-0 flex-nowrap">
          <AnimatePresence mode="popLayout" initial={false}>
            {enabled ? (
              <Button
                size="small"
                key="stop"
                type="button"
                variant="ghost"
                className="enabled:hover:bg-surface"
                aria-label={`暂停${name}`}
                title="暂停播放"
                icon={<Pause size={15} />}
                layout="position"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.16 } }}
                onClick={() => onEnabledChange(false)}
              />
            ) : null}
          </AnimatePresence>
          <Button
            size="small"
            type="button"
            variant={enabled ? "ghost" : "secondary"}
            className={enabled ? "enabled:hover:bg-surface" : undefined}
            layout="position"
            aria-label={`${enabled ? "重新播放" : "开始播放"}${name}`}
            title={enabled ? "重新播放" : "开始播放"}
            icon={enabled ? <RotateCcw size={15} /> : <Play size={15} />}
            onClick={() => {
              restart();
              onEnabledChange(true);
            }}
          />
          {!expanded ? (
            <Link
              to="/cameras/$deviceId/$channel/view"
              params={{ deviceId, channel: String(channel) }}
              className={twMerge(
                `${buttonStyles.base} ${buttonStyles.ghost} size-8 min-h-8 min-w-8 rounded-[10px] p-0 hover:bg-surface hover:text-ink`,
              )}
              aria-label={`放大查看${name}`}
              title="放大查看"
            >
              <Maximize size={15} aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      </CameraHeader>
      <CameraFrame
        aspectRatio={aspectRatio}
        transitionName={cameraTransitionName(deviceId, channel)}
        notice={notice}
        statusAction={statusAction}
        waiting={
          playing &&
          snapshot.firstFrameAt === null &&
          (snapshot.phase === "connecting" || snapshot.phase === "waiting")
        }
        placeholder={
          !playing
            ? enabled
              ? "画面可见时自动播放"
              : "已暂停播放"
            : snapshot.phase === "error"
              ? "暂时无法播放"
              : snapshot.firstFrameAt !== null
                ? null
                : "等待摄像头画面"
        }
        tone={playing ? presentation.tone : "unknown"}
        status={playing ? presentation.label : enabled ? "等待显示" : "已暂停"}
        loader={<PlaybackLoader active={playing && snapshot.visible} />}
        statusContent={
          playing ? <PlaybackStatus snapshot={snapshot} /> : undefined
        }
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-label={`${name} 实时画面`}
        />
      </CameraFrame>
    </div>
  );
}
