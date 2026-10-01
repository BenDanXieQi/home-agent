import { usePlaybackSessions } from "../../modules/playback/playback-context";
import { CameraFullscreen } from "./CameraFullscreen";
import { CameraHeader } from "./CameraHeader";
import { twMerge } from "tailwind-merge";
import { Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "../../components/Button";
import { useState, type ReactNode, type ComponentProps } from "react";
import { AnimatePresence, m } from "motion/react";
import { contentSwap } from "../../utils/motion";
import { useMijiaPlayback } from "../../modules/playback/use-mijia-playback";
import {
  playbackPresentation,
  playbackBadgeTones,
} from "./playback-presentation";
import { PlaybackLoader } from "./PlaybackLoader";
import { PlaybackStatus } from "./PlaybackStatus";

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
}) {
  return (
    <>
      <div className="camera-surface relative aspect-video w-full bg-[#111111] [&_video]:block [&_video]:size-full [&_video]:object-contain">
        {children}
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

function CameraPlayback({
  revision,
  scope_epoch,
  deviceId,
  channel,
  name,
  notice,
  statusAction,
}: Parameters<typeof useMijiaPlayback>[0] & {
  name: string;
  notice?: ReactNode;
  statusAction?: ReactNode;
}) {
  const { videoRef, snapshot } = useMijiaPlayback({
    revision,
    scope_epoch,
    deviceId,
    channel,
  });
  const presentation = playbackPresentation(snapshot);

  return (
    <CameraFrame
      notice={notice}
      statusAction={statusAction}
      waiting={snapshot.phase === "connecting" || snapshot.phase === "waiting"}
      placeholder={
        snapshot.phase === "playing" ||
        (snapshot.phase === "hidden" && snapshot.firstFrameAt !== null)
          ? null
          : snapshot.phase === "error"
            ? "暂时无法播放"
            : "等待摄像头画面"
      }
      tone={presentation.tone}
      status={presentation.label}
      loader={<PlaybackLoader active={snapshot.visible} />}
      statusContent={<PlaybackStatus snapshot={snapshot} />}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        aria-label={`${name} 实时画面`}
      />
    </CameraFrame>
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
}: ComponentProps<typeof CameraPlayback> & {
  enabled: boolean;
  active: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const sessions = usePlaybackSessions();
  return (
    <CameraFullscreen name={name}>
      <CameraHeader title={name}>
        <div className="flex gap-1 relative shrink-0 flex-nowrap mr-10">
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
              sessions.invalidate({ deviceId, channel, scope_epoch, revision });
              setAttempt((value) => value + 1);
              onEnabledChange(true);
            }}
          />
        </div>
      </CameraHeader>
      {enabled && active ? (
        <CameraPlayback
          key={attempt}
          revision={revision}
          scope_epoch={scope_epoch}
          deviceId={deviceId}
          channel={channel}
          name={name}
          notice={notice}
          statusAction={statusAction}
        />
      ) : (
        <CameraFrame
          notice={notice}
          statusAction={statusAction}
          placeholder={enabled ? "画面可见时自动播放" : "已暂停播放"}
          tone="unknown"
          status={enabled ? "等待显示" : "已暂停"}
        />
      )}
    </CameraFullscreen>
  );
}
