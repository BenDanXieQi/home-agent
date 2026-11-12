import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { Button } from "../../components/Button";
import { buttonStyles } from "../../components/button-styles";
import type { AnalysisSummary } from "../../modules/dynamics/queries";

const playbackRetentionDays = 7;

export function OriginalRecordingLink({
  entry,
}: {
  entry: Pick<AnalysisSummary, "source" | "startedAt" | "endedAt">;
}) {
  const expiresAt = entry.startedAt + playbackRetentionDays * 24 * 60 * 60_000;
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  if (now >= expiresAt) {
    return (
      <Button
        disabled
        title={`录像距今已满 ${playbackRetentionDays} 天`}
        icon={<Play size={14} strokeWidth={1.5} aria-hidden="true" />}
      >
        已过期
      </Button>
    );
  }

  return (
    <Link
      to="/cameras/$deviceId/$channel"
      params={{
        deviceId: entry.source.deviceId,
        channel: String(entry.source.channel),
      }}
      search={{
        returnTo: "/dynamics",
        mode: "windows",
        window: undefined,
        rangeStart: entry.startedAt,
        rangeEnd: entry.endedAt,
        activityRun: undefined,
        member: undefined,
        activityFirstAt: undefined,
        activityAt: undefined,
      }}
      className={`${buttonStyles.base} ${buttonStyles.secondary} hover:bg-sidebar focus-visible:outline-2`}
    >
      <Play size={14} strokeWidth={1.5} aria-hidden="true" />
      查看原片
    </Link>
  );
}
