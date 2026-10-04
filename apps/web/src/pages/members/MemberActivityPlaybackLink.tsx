import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { z } from "zod";
import { ChevronRight } from "lucide-react";
import type { memberActivitySourceSchema } from "../../modules/members/activity";
import type { useActivityPlayback } from "../../modules/members/use-activity-playback";

export function MemberActivityPlaybackLink({
  source,
  memberId,
  availability,
  className,
  children,
}: {
  source: z.infer<typeof memberActivitySourceSchema>;
  memberId: string;
  availability: ReturnType<ReturnType<typeof useActivityPlayback>["get"]>;
  className: string;
  children: ReactNode;
}) {
  const { window, clip, checking } = availability ?? {};
  const arrow = (
    <ChevronRight
      size={16}
      strokeWidth={1.5}
      aria-hidden="true"
      className="self-center text-muted group-hover:text-ink max-sm:absolute max-sm:right-4 max-sm:top-4"
    />
  );
  const linkClassName = `group ${className} hover:bg-ink/3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink`;
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
        {children}
        {arrow}
      </Link>
    );
  if (clip)
    return (
      <Link
        to="/cameras/$deviceId/$channel/recording"
        params={{ deviceId: source.deviceId, channel: String(source.channel) }}
        search={{
          recordingAt: clip.startAt,
          activityRun: source.sourceRunId,
          activityFirstAt: source.firstObservedAt,
          activityAt: source.lastObservedAt,
          member: memberId,
        }}
        className={linkClassName}
      >
        {children}
        {arrow}
      </Link>
    );
  return (
    <div
      className={className}
      title={checking ? "正在检查对应录像" : "没有可回看的对应录像"}
    >
      {children}
    </div>
  );
}
