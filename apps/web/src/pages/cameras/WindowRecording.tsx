import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
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
        <StatusNotice>片段摘要已过期，无法再查找对应的 SD 录像。</StatusNotice>
      ) : !authorized ? (
        <StatusNotice>等待当前家庭与摄像头连接就绪后查找。</StatusNotice>
      ) : null}
      <RecordingPlayer playback={playback} />
      <p className="text-xs leading-5 text-muted">
        语音文字和人物判断来自窗口采集，不是对整段 SD 录像的重新分析。
        未对齐的候选录像不能直接套用这些记录。
      </p>
    </div>
  );
}
