import { Link, useParams } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ArrowUpRight } from "lucide-react";
import { Notice, StatusNotice } from "../../components/Notice";
import { BackLink } from "../../components/BackLink";
import { buttonStyles } from "../../components/button-styles";
import { devicesAtom } from "../../modules/devices/state";
import {
  householdScopeEpochAtom,
  householdSyncedAtom,
} from "../../modules/household/state";
import { canStartPlaybackAtom } from "../../modules/playback/access";
import { playbackPageActiveAtom } from "../../modules/playback/page-activity";
import {
  pausedPlaybackKeysAtom,
  setPlaybackEnabledAtom,
} from "../../modules/playback/preferences";
import { mediaStateAtom } from "../../modules/playback/state";
import { MijiaPlayer } from "./MijiaPlayer";
import { cameraTileClassName } from "./camera-styles";
import { useCameraReturn } from "./use-camera-return";

export default function CameraViewPage() {
  useCameraReturn();
  const { deviceId, channel } = useParams({
    from: "/account/cameras/$deviceId/$channel/view",
  });
  const epoch = useAtomValue(householdScopeEpochAtom);
  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <BackLink
          activeOptions={{ exact: true }}
          to="/cameras"
          className="-ml-2"
        >
          返回看家
        </BackLink>
        <Link
          to="/cameras/$deviceId/$channel"
          search={{
            mode: undefined,
            window: undefined,
            activityRun: undefined,
            activityAt: undefined,
            activityFirstAt: undefined,
            member: undefined,
          }}
          params={{ deviceId, channel }}
          className={`${buttonStyles.base} ${buttonStyles.secondary}`}
        >
          画面分析 <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </div>
      {channel === "1" || channel === "2" ? (
        <CameraView
          key={`${epoch}:${deviceId}:${channel}`}
          deviceId={deviceId}
          channel={channel === "1" ? 1 : 2}
        />
      ) : (
        <Notice tone="error">镜头不存在。</Notice>
      )}
    </section>
  );
}

function CameraView({
  deviceId,
  channel,
}: {
  deviceId: string;
  channel: 1 | 2;
}) {
  const devices = useAtomValue(devicesAtom);
  const synced = useAtomValue(householdSyncedAtom);
  const epoch = useAtomValue(householdScopeEpochAtom);
  const media = useAtomValue(mediaStateAtom);
  const ready = useAtomValue(canStartPlaybackAtom);
  const active = useAtomValue(playbackPageActiveAtom);
  const paused = useAtomValue(pausedPlaybackKeysAtom);
  const setEnabled = useSetAtom(setPlaybackEnabledAtom);
  const playbackKey = `${deviceId}:${channel}`;
  const device = devices.find((item) => item.id === deviceId);
  if (synced && (!device?.camera || !device.channels.includes(channel)))
    return <Notice tone="warning">该镜头不在当前家庭的设备清单中。</Notice>;
  if (!device || !epoch || !media)
    return <StatusNotice>正在同步设备清单…</StatusNotice>;
  const name =
    device.channels.length > 1
      ? `${device.name} · 镜头 ${channel}`
      : device.name;
  return (
    <article
      className={`${cameraTileClassName} min-h-0 flex-1 [&_.camera-surface]:min-h-0 [&_.camera-surface]:flex-1 [&_.camera-surface]:aspect-auto`}
    >
      <MijiaPlayer
        revision={media.revision}
        scope_epoch={epoch}
        deviceId={deviceId}
        channel={channel}
        name={name}
        expanded
        enabled={!paused.has(playbackKey)}
        active={active && ready}
        onEnabledChange={(enabled) => setEnabled(playbackKey, enabled)}
        notice={!device.online ? "设备离线，保留现有画面" : null}
      />
    </article>
  );
}
