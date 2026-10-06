import { Link } from "@tanstack/react-router";
import type { z } from "zod";
import { Clock3, Play, VideoOff } from "lucide-react";
import { twMerge } from "tailwind-merge";
import type { observationPlaybackSourceSchema } from "../modules/playback/observation";
import type { useObservationPlayback } from "../modules/playback/use-observation-playback";
import { buttonStyles } from "./button-styles";
import { Button } from "./Button";
import { requestErrorMessage } from "../messages/zh-CN";
import { recordingLookupUnavailableText } from "../modules/recordings/presentation";

export function ObservationPlaybackLink({
  source,
  memberId,
  windowId,
  availability,
}: {
  source: z.infer<typeof observationPlaybackSourceSchema>;
  memberId?: string;
  windowId?: string | undefined;
  availability: ReturnType<ReturnType<typeof useObservationPlayback>["get"]>;
}) {
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
  if (availability?.status === "window") {
    const { window } = availability;
    return (
      <Link
        to="/cameras/$deviceId/$channel"
        params={{ deviceId: source.deviceId, channel: String(source.channel) }}
        search={{
          mode: "windows",
          window: window.id,
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
  }
  if (availability?.status === "recording") {
    const { clip, checking, seekAt } = availability;
    return (
      <Link
        to="/cameras/$deviceId/$channel/recording"
        disabled={checking}
        params={{ deviceId: source.deviceId, channel: String(source.channel) }}
        search={{
          recordingAt: clip.startAt,
          seekAt,
          window: windowId,
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
  }
  if (
    availability?.status === "failed" ||
    availability?.status === "unavailable"
  )
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2 text-xs text-danger"
      >
        <span>
          {availability.status === "failed"
            ? `画面查询失败：${requestErrorMessage(availability.error)}`
            : recordingLookupUnavailableText[availability.reason]}
        </span>
        <Button
          size="small"
          variant="ghost"
          onClick={() => {
            availability.retry().catch(() => {
              console.warn("Observation playback lookup retry failed");
            });
          }}
        >
          重新查找
        </Button>
      </div>
    );
  const waiting =
    availability === undefined || availability.status === "waiting";
  const checking = waiting || availability?.status === "checking";
  return (
    <span className="inline-flex min-h-8 items-center gap-1.5 text-xs leading-6 text-muted">
      {checking ? (
        <Clock3 size={14} strokeWidth={1.5} aria-hidden="true" />
      ) : (
        <VideoOff size={14} strokeWidth={1.5} aria-hidden="true" />
      )}
      <span>
        {waiting
          ? "正在等待摄像头连接…"
          : checking
            ? "正在查找可回看的画面…"
            : "暂无可回看的画面"}
      </span>
    </span>
  );
}
