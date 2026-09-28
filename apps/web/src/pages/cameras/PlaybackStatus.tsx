import { twMerge } from "tailwind-merge";
import { type ComponentProps, type ReactNode } from "react";
import { usePlaybackClock } from "../../modules/playback/use-playback-clock";
import { estimatePlaybackHistory } from "../../modules/playback/history";
import type { PlaybackSession } from "../../modules/playback/session";
import {
  playbackBadgeTones,
  playbackPresentation,
  remainingPlaybackTime,
} from "./playback-presentation";

function StatusLine({
  presentation,
  error = false,
  children,
}: {
  presentation: ReturnType<typeof playbackPresentation>;
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <span
        className={twMerge(
          `status-badge inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] ${playbackBadgeTones[presentation.tone]}`,
        )}
      >
        <span
          className="status-dot size-1.5 rounded-full bg-current"
          aria-hidden="true"
        />
        {presentation.label}
      </span>
      <output className="sr-only" aria-live="polite" aria-atomic="true">
        {error ? "" : presentation.message}
      </output>
      {children}
    </>
  );
}

function WaitingPlaybackStatus({
  snapshot,
}: ComponentProps<typeof PlaybackStatus>) {
  const clock = usePlaybackClock(snapshot.startedAt);
  const presentation = playbackPresentation(snapshot);
  const anchor = snapshot.answerAppliedAt;
  const estimate =
    anchor === null
      ? null
      : estimatePlaybackHistory({
          context: snapshot.historyContext,
          sourceRecentlyActive:
            snapshot.connection?.sourceRecentlyActive ?? null,
          elapsedMs: Math.max(0, clock.monotonicMs - anchor),
          now: clock.wallMs,
        });
  const elapsedMs =
    snapshot.startedAt === null
      ? 0
      : Math.max(0, clock.monotonicMs - snapshot.startedAt);
  const message = `已等待 ${Math.floor(elapsedMs / 1_000)} 秒${estimate ? ` · ${remainingPlaybackTime(estimate)}` : ""}`;
  return (
    <StatusLine presentation={presentation}>
      <p
        className="tabular-nums"
        aria-live="off"
        title={
          estimate
            ? `${message}；依据此浏览器相近连接条件的成功记录，可能超出此范围。`
            : message
        }
      >
        {message}
      </p>
    </StatusLine>
  );
}

/** Only visible viewers waiting for their first frame need a clock. */
export function PlaybackStatus({
  snapshot,
}: {
  snapshot: ReturnType<PlaybackSession["getSnapshot"]>;
}) {
  if (
    snapshot.visible &&
    snapshot.firstFrameAt === null &&
    (snapshot.phase === "connecting" || snapshot.phase === "waiting")
  )
    return (
      <WaitingPlaybackStatus
        key={snapshot.visibilityVersion}
        snapshot={snapshot}
      />
    );
  const presentation = playbackPresentation(snapshot);
  return (
    <StatusLine presentation={presentation} error={snapshot.phase === "error"}>
      {snapshot.phase === "playing" &&
      snapshot.startedAt !== null &&
      snapshot.firstFrameAt !== null ? (
        <p className="tabular-nums" title="从开始连接到首次显示画面的实际耗时">
          连接用时{" "}
          {((snapshot.firstFrameAt - snapshot.startedAt) / 1_000).toFixed(1)} 秒
        </p>
      ) : (
        <p role={snapshot.phase === "error" ? "alert" : undefined}>
          {presentation.message}
        </p>
      )}
    </StatusLine>
  );
}
