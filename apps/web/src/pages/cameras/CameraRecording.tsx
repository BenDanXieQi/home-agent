import { formatTime } from "../../modules/presentation/time";
import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import type { z } from "zod";
import { Button } from "../../components/Button";
import { BackLink } from "../../components/BackLink";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import type { observationPlaybackSourceSchema } from "../../modules/playback/observation";
import { useObservationRecording } from "../../modules/playback/use-observation-recording";
import { RecordingPlayer } from "../../modules/recordings/RecordingPlayer";
import { useCameraReturn } from "./use-camera-return";

export default function CameraRecordingPage() {
  useCameraReturn();
  const { deviceId, channel } = useParams({
    from: "/account/cameras/$deviceId/$channel/recording",
  });
  const {
    member,
    recordingAt,
    seekAt,
    activityAt,
    activityRun,
    activityFirstAt,
    window: windowId,
  } = useSearch({
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
      seekAt !== undefined &&
      activityRun !== undefined &&
      activityFirstAt !== undefined &&
      activityAt !== undefined ? (
        <ObservationRecording
          key={`${deviceId}:${channel}:${windowId ?? ""}:${recordingAt}:${seekAt}:${activityRun}:${activityFirstAt}:${activityAt}`}
          activity={{
            deviceId,
            channel: channel === "1" ? 1 : 2,
            sourceRunId: activityRun,
            firstObservedAt: activityFirstAt,
            lastObservedAt: activityAt,
          }}
          member={member}
          windowId={windowId}
          recordingAt={recordingAt}
          seekAt={seekAt}
        />
      ) : (
        <Notice tone="error">录像定位信息不完整。</Notice>
      )}
    </section>
  );
}

function ObservationRecording({
  activity,
  member,
  recordingAt,
  seekAt,
  windowId,
}: {
  activity: z.infer<typeof observationPlaybackSourceSchema>;
  member: string | undefined;
  recordingAt: number;
  seekAt: number;
  windowId: string | undefined;
}) {
  const recording = useObservationRecording(activity, recordingAt, windowId);
  if (recording.cached)
    return (
      <Navigate
        to="/cameras/$deviceId/$channel"
        params={{
          deviceId: activity.deviceId,
          channel: String(activity.channel),
        }}
        search={{
          mode: "windows",
          window: recording.cached.id,
          activityRun: activity.sourceRunId,
          activityFirstAt: activity.firstObservedAt,
          activityAt: activity.lastObservedAt,
          member,
        }}
        replace
      />
    );
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium">观察录像 · {formatTime(seekAt)}</h2>
      {!recording.target ? (
        <StatusNotice>等待摄像头连接就绪…</StatusNotice>
      ) : recording.error ? (
        <Notice tone="error">
          缓存录像查询失败：{requestErrorMessage(recording.error)}
          <Button
            onClick={() => {
              // Refetch exposes request failures through recording.error.
              // oxlint-disable-next-line typescript/no-floating-promises
              recording.retry();
            }}
          >
            重新读取
          </Button>
        </Notice>
      ) : recording.ready ? (
        <RecordingPlayer
          playback={recording.playback}
          activityAt={seekAt}
          autoPlay
        />
      ) : (
        <StatusNotice>正在查找缓存录像…</StatusNotice>
      )}
    </div>
  );
}
