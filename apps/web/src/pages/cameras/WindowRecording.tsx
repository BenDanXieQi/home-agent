import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { Button } from "../../components/Button";
import { StatusNotice } from "../../components/Notice";
import { createPerceptionSourceState } from "../../modules/perception/source-state";
import type { PerceptionWindow } from "../../modules/perception/windows";
import { RecordingPlayer } from "../../modules/recordings/RecordingPlayer";
import { useRecordingPlayback } from "../../modules/recordings/use-recording-playback";

export function WindowRecording({
  window,
  active,
}: {
  window: PerceptionWindow;
  active: boolean;
}) {
  const [source] = useState(() =>
    createPerceptionSourceState({
      deviceId: window.run.deviceId,
      channel: window.run.channel,
    }),
  );
  const target = useAtomValue(source.playbackTargetAtom);
  const authorized = active && target?.scope_epoch === window.run.scopeEpoch;
  const playback = useRecordingPlayback(authorized ? target : null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, window.summaryUntil - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [window.summaryUntil]);
  const summaryAvailable = now < window.summaryUntil;

  return (
    <div className="space-y-3 rounded-xl border border-line p-3">
      <div>
        <h3 className="text-sm font-medium">摄像头原始录像</h3>
        <p className="mt-1 text-xs leading-5 text-muted">
          可从 SD
          卡查找这一事件附近的完整录像。本地采样媒体过期后，保留的窗口摘要仍可用于查找。
        </p>
      </div>
      {!playback.request ? (
        <Button
          disabled={!authorized || !summaryAvailable}
          onClick={() => {
            setNow(Date.now());
            if (Date.now() >= window.summaryUntil) return;
            playback.start({ kind: "window", windowId: window.id });
          }}
        >
          查找 SD 录像
        </Button>
      ) : null}
      {!summaryAvailable ? (
        <StatusNotice>
          窗口摘要已过期，可前往“SD 录像”按设备时间查找。
        </StatusNotice>
      ) : !authorized ? (
        <StatusNotice>等待当前家庭与摄像头连接就绪后查找。</StatusNotice>
      ) : null}
      <RecordingPlayer playback={playback} />
      <Link
        to="/cameras/$deviceId/$channel"
        params={{
          deviceId: window.run.deviceId,
          channel: String(window.run.channel),
        }}
        search={{ mode: "recordings" }}
        className="inline-block rounded text-xs underline underline-offset-4 focus-visible:outline-2"
      >
        按日期查看 SD 录像
      </Link>
      <p className="text-xs leading-5 text-muted">
        下方身份记录属于窗口当时保留的采样帧，不代表整段 SD
        录像中每个时刻的人物身份。
      </p>
    </div>
  );
}
