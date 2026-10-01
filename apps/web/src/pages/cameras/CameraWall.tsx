import { Link } from "@tanstack/react-router";
import {
  cameraTileClassName,
  cameraGridClassName,
  cameraTransitionName,
} from "./camera-styles";
import { CameraHeader } from "./CameraHeader";
import { EmptyState } from "../../components/EmptyState";
import { memo, useMemo, useRef, type ComponentProps } from "react";
import { useInView } from "motion/react";
import { useAtomValue, useSetAtom } from "jotai";
import { playbackPageActiveAtom } from "../../modules/playback/page-activity";
import {
  pausedPlaybackKeysAtom,
  setPlaybackEnabledAtom,
} from "../../modules/playback/preferences";
import { twMerge } from "tailwind-merge";
import { buttonStyles } from "../../components/button-styles";
import { ArrowUpRight, Video } from "lucide-react";
import { CameraWallSkeleton } from "./skeletons";
import type { Projection } from "@home-agent/api/household";
import { CameraFrame, MijiaPlayer } from "./MijiaPlayer";
import type { deviceInventoryAtom } from "../../modules/devices/state";

const cameraNameOrder = new Intl.Collator("zh-CN", { numeric: true });

const CameraTile = memo(function CameraTile({
  device,
  revision,
  scope_epoch,
  channel,
  ready,
  pageActive,
  playbackKey,
  enabled,
  onEnabledChange,
}: Pick<
  ComponentProps<typeof MijiaPlayer>,
  "revision" | "scope_epoch" | "channel" | "enabled"
> & {
  device: Projection["device"][string];
  ready: boolean;
  pageActive: boolean;
  playbackKey: string;
  onEnabledChange: (key: string, enabled: boolean) => void;
}) {
  const tile = useRef<HTMLElement>(null);
  // Prepare the next row before it enters view without retaining distant viewers.
  const nearViewport = useInView(tile, { margin: "240px 0px" });
  const label =
    device.channels.length > 1
      ? `${device.name} · 镜头 ${channel}`
      : device.name;
  const notice =
    device.availability === "offline" ? "设备离线，保留现有画面" : null;
  const analysisLink = (
    <Link
      to="/cameras/$deviceId/$channel"
      params={{ deviceId: device.id, channel: String(channel) }}
      aria-label={label + "画面分析"}
      className={twMerge(
        `${buttonStyles.base} ${buttonStyles.secondary} min-h-7 gap-0.5 rounded-[10px] py-1 pl-2 pr-1.5 text-xs hover:bg-sidebar focus-visible:outline-2`,
      )}
    >
      画面分析 <ArrowUpRight size={14} aria-hidden="true" />
    </Link>
  );
  return (
    <article ref={tile} className={cameraTileClassName}>
      {ready ? (
        <MijiaPlayer
          revision={revision}
          scope_epoch={scope_epoch}
          deviceId={device.id}
          channel={channel}
          name={label}
          enabled={enabled}
          active={pageActive && nearViewport}
          notice={notice}
          statusAction={analysisLink}
          onEnabledChange={(value) => onEnabledChange(playbackKey, value)}
        />
      ) : (
        <>
          <CameraHeader title={label}>
            <span className="flex min-h-6 items-center text-xs text-muted">
              等待连接
            </span>
          </CameraHeader>
          <CameraFrame
            transitionName={cameraTransitionName(device.id, channel)}
            notice={notice}
            statusAction={analysisLink}
            placeholder="摄像头服务尚未就绪"
            tone="unknown"
            status="未就绪"
          />
        </>
      )}
    </article>
  );
});

export default function CameraWall({
  devices,
  revision,
  scope_epoch,
  ready,
}: {
  devices: NonNullable<ReturnType<typeof deviceInventoryAtom.read>>;
  revision: string;
  scope_epoch: string;
  ready: boolean;
}) {
  const pageActive = useAtomValue(playbackPageActiveAtom);
  const paused = useAtomValue(pausedPlaybackKeysAtom);
  const changeEnabled = useSetAtom(setPlaybackEnabledAtom);
  // Display order belongs to the camera wall, not the cloud response order.
  const cameras = useMemo(
    () =>
      devices.items
        .filter((device) => device.camera)
        .toSorted(
          (left, right) =>
            cameraNameOrder.compare(left.name, right.name) ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        ),
    [devices.items],
  );
  return (
    <>
      {cameras.length ? (
        <div className={cameraGridClassName}>
          {cameras.flatMap((device) =>
            device.channels.map((channel) => (
              <CameraTile
                key={`${revision}:${device.id}:${channel}`}
                device={device}
                channel={channel}
                revision={revision}
                scope_epoch={scope_epoch}
                ready={ready}
                pageActive={pageActive}
                playbackKey={`${device.id}:${channel}`}
                enabled={!paused.has(`${device.id}:${channel}`)}
                onEnabledChange={changeEnabled}
              />
            )),
          )}
        </div>
      ) : null}
      {!cameras.length && devices.status === "loading" ? (
        <CameraWallSkeleton />
      ) : !cameras.length && devices.status !== "error" ? (
        <EmptyState
          icon={<Video size={24} />}
          title="这个家庭还没有摄像头"
          description="设备清单中的摄像头会显示在这里。新添加的设备会在后台同步后自动出现。"
        />
      ) : null}
    </>
  );
}
