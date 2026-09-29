import { cameraTileClassName, cameraGridClassName } from "./camera-styles";
import { CameraHeader } from "./CameraHeader";
import { EmptyState } from "../../components/EmptyState";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useInView, usePageInView } from "motion/react";
import { Video } from "lucide-react";
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
  pageVisible,
  playbackKey,
  enabled,
  onEnabledChange,
}: Pick<
  ComponentProps<typeof MijiaPlayer>,
  "revision" | "scope_epoch" | "channel" | "enabled"
> & {
  device: Projection["device"][string];
  ready: boolean;
  pageVisible: boolean;
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
          active={pageVisible && nearViewport}
          notice={notice}
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
            notice={notice}
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
  const pageVisible = usePageInView();
  // Playback choices outlive a camera's temporary offline state or media revision.
  // The household epoch's React key clears them when the managed scope changes.
  const [paused, setPaused] = useState(() => new Set<string>());
  const changeEnabled = useCallback((key: string, enabled: boolean) => {
    setPaused((previous) => {
      const next = new Set(previous);
      if (enabled) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
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
                pageVisible={pageVisible}
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
