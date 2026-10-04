import { useEffect, useState } from "react";
import { useParams, useSearch } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { BackLink } from "../../components/BackLink";
import { Notice, StatusNotice } from "../../components/Notice";
import { createPerceptionSourceState } from "../../modules/perception/source-state";
import { useRecordingPlayback } from "../../modules/recordings/use-recording-playback";
import { RecordingPlayer } from "../../modules/recordings/RecordingPlayer";
import { useCameraReturn } from "./use-camera-return";

export default function CameraRecordingPage() {
  useCameraReturn();
  const { deviceId, channel } = useParams({
    from: "/account/cameras/$deviceId/$channel/recording",
  });
  const { member, recordingAt, activityAt } = useSearch({
    from: "/account/cameras/$deviceId/$channel/recording",
  });
  return (
    <section className="space-y-4">
      {member ? (
        <BackLink to="/members" search={{ member }}>
          返回成员
        </BackLink>
      ) : (
        <BackLink to="/cameras">返回看家</BackLink>
      )}
      {(channel === "1" || channel === "2") &&
      recordingAt !== undefined &&
      activityAt !== undefined ? (
        <ActivityRecording
          key={`${deviceId}:${channel}:${recordingAt}:${activityAt}`}
          deviceId={deviceId}
          channel={channel === "1" ? 1 : 2}
          recordingAt={recordingAt}
          activityAt={activityAt}
        />
      ) : (
        <Notice tone="error">录像定位信息不完整。</Notice>
      )}
    </section>
  );
}

function ActivityRecording({
  deviceId,
  channel,
  recordingAt,
  activityAt,
}: {
  deviceId: string;
  channel: 1 | 2;
  recordingAt: number;
  activityAt: number;
}) {
  const [source] = useState(() =>
    createPerceptionSourceState({ deviceId, channel }),
  );
  const target = useAtomValue(source.playbackTargetAtom);
  const playback = useRecordingPlayback(target);
  const { start } = playback;
  useEffect(() => {
    if (!target) return;
    start({ kind: "clip", startAt: recordingAt });
  }, [target, recordingAt, start]);
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium">
        活动录像 · {new Date(activityAt).toLocaleString("zh-CN")}
      </h2>
      {!target ? <StatusNotice>等待摄像头连接就绪…</StatusNotice> : null}
      <RecordingPlayer playback={playback} activityAt={activityAt} autoPlay />
    </div>
  );
}
