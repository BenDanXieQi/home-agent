import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import type { z } from "zod";
import { Button } from "../../components/Button";
import { BackLink } from "../../components/BackLink";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import type { memberActivitySourceSchema } from "../../modules/members/activity";
import { useActivityRecording } from "../../modules/members/use-activity-recording";
import { RecordingPlayer } from "../../modules/recordings/RecordingPlayer";
import { useCameraReturn } from "./use-camera-return";

export default function CameraRecordingPage() {
  useCameraReturn();
  const { deviceId, channel } = useParams({
    from: "/account/cameras/$deviceId/$channel/recording",
  });
  const { member, recordingAt, activityAt, activityRun, activityFirstAt } =
    useSearch({
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
      activityRun !== undefined &&
      activityFirstAt !== undefined &&
      activityAt !== undefined ? (
        <ActivityRecording
          key={`${deviceId}:${channel}:${recordingAt}:${activityRun}:${activityFirstAt}:${activityAt}`}
          activity={{
            deviceId,
            channel: channel === "1" ? 1 : 2,
            sourceRunId: activityRun,
            firstObservedAt: activityFirstAt,
            lastObservedAt: activityAt,
          }}
          member={member}
          recordingAt={recordingAt}
        />
      ) : (
        <Notice tone="error">录像定位信息不完整。</Notice>
      )}
    </section>
  );
}

function ActivityRecording({
  activity,
  member,
  recordingAt,
}: {
  activity: z.infer<typeof memberActivitySourceSchema>;
  member: string | undefined;
  recordingAt: number;
}) {
  const recording = useActivityRecording(activity, recordingAt);
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
      <h2 className="text-sm font-medium">
        活动录像 · {new Date(activity.lastObservedAt).toLocaleString("zh-CN")}
      </h2>
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
          activityAt={activity.lastObservedAt}
          autoPlay
        />
      ) : (
        <StatusNotice>正在查找缓存录像…</StatusNotice>
      )}
    </div>
  );
}
