import { Link } from "@tanstack/react-router";
import type { z } from "zod";
import { Clock3, Play, VideoOff } from "lucide-react";
import { twMerge } from "tailwind-merge";
import type { memberActivitySourceSchema } from "../../modules/members/activity";
import type { useActivityPlayback } from "../../modules/members/use-activity-playback";
import { buttonStyles } from "../../components/button-styles";

export function MemberActivityPlaybackLink({
  source,
  memberId,
  availability,
}: {
  source: z.infer<typeof memberActivitySourceSchema>;
  memberId: string;
  availability: ReturnType<ReturnType<typeof useActivityPlayback>["get"]>;
}) {
  const { window, clip, checking } = availability ?? {};
  const label = (
    <>
      <Play size={14} strokeWidth={1.5} aria-hidden="true" />
      查看画面
    </>
  );
  const linkClassName = twMerge(
    buttonStyles.base,
    buttonStyles.secondary,
    "min-h-8 px-3 py-1.5 text-xs hover:bg-sidebar focus-visible:outline-2",
  );
  if (window)
    return (
      <Link
        to="/cameras/$deviceId/$channel"
        params={{ deviceId: source.deviceId, channel: String(source.channel) }}
        search={{
          mode: "windows",
          activityRun: source.sourceRunId,
          activityFirstAt: source.firstObservedAt,
          activityAt: source.lastObservedAt,
          member: memberId,
        }}
        className={linkClassName}
      >
        {label}
      </Link>
    );
  if (clip)
    return (
      <Link
        to="/cameras/$deviceId/$channel/recording"
        disabled={checking === true}
        params={{ deviceId: source.deviceId, channel: String(source.channel) }}
        search={{
          recordingAt: clip.startAt,
          activityRun: source.sourceRunId,
          activityFirstAt: source.firstObservedAt,
          activityAt: source.lastObservedAt,
          member: memberId,
        }}
        className={twMerge(linkClassName, checking ? "cursor-progress" : "")}
      >
        {label}
      </Link>
    );
  return (
    <span className="inline-flex min-h-8 items-center gap-1.5 text-xs leading-6 text-muted">
      {checking ? (
        <Clock3 size={14} strokeWidth={1.5} aria-hidden="true" />
      ) : (
        <VideoOff size={14} strokeWidth={1.5} aria-hidden="true" />
      )}
      <span>{checking ? "正在查找可回看的画面…" : "暂无可回看的画面"}</span>
    </span>
  );
}
