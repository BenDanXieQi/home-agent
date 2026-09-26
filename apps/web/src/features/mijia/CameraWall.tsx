import { memo, useCallback, useState } from "react";
import { Video } from "lucide-react";
import type { MijiaState } from "@home-agent/api/mijia";
import { MijiaPlayer } from "./MijiaPlayer";

const cameraNameOrder = new Intl.Collator("zh-CN", { numeric: true });

const CameraTile = memo(function CameraTile({
  device,
  revision,
  channel,
  ready,
  confirming,
  playbackKey,
  enabled,
  onEnabledChange,
}: {
  device: MijiaState["devices"]["items"][number];
  revision: string;
  channel: 1 | 2;
  ready: boolean;
  confirming: boolean;
  playbackKey: string;
  enabled: boolean;
  onEnabledChange: (key: string, enabled: boolean) => void;
}) {
  const label =
    device.channels.length > 1
      ? `${device.name} · 镜头 ${channel}`
      : device.name;
  return (
    <article className="camera-tile">
      {!device.online ? (
        <output className="notice">离线状态确认中，暂时保留现有画面。</output>
      ) : null}
      {ready ? (
        <MijiaPlayer
          revision={revision}
          deviceId={device.id}
          channel={channel}
          name={label}
          enabled={enabled}
          onEnabledChange={(value) => onEnabledChange(playbackKey, value)}
        />
      ) : (
        <>
          <div className="camera-tile-heading">
            <h2>{label}</h2>
            <span>{confirming ? "正在确认" : "等待连接"}</span>
          </div>
          <div className="camera-idle">
            <Video size={28} strokeWidth={1} />
            <p>
              {confirming
                ? "正在确认当前账号与摄像头状态…"
                : "摄像头服务尚未就绪"}
            </p>
          </div>
        </>
      )}
    </article>
  );
});

export default function CameraWall({
  state,
  ready,
  confirming,
}: {
  state: Pick<MijiaState, "account" | "revision" | "binding"> & {
    devices: Pick<MijiaState["devices"], "items" | "status">;
  };
  ready: boolean;
  confirming: boolean;
}) {
  // Playback choices outlive a camera's temporary offline state or media revision.
  // The owning account's React key clears them when that account changes.
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
  const cameras = state.devices.items
    .filter((device) => device.camera)
    .toSorted(
      (left, right) =>
        cameraNameOrder.compare(left.name, right.name) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  return (
    <>
      <div className="camera-wall">
        {cameras.flatMap((device) =>
          device.channels.map((channel) => (
            <CameraTile
              key={`${state.revision}:${device.id}:${channel}`}
              device={device}
              channel={channel}
              revision={state.revision}
              ready={ready}
              confirming={confirming}
              playbackKey={`${device.id}:${channel}`}
              enabled={!paused.has(`${device.id}:${channel}`)}
              onEnabledChange={changeEnabled}
            />
          )),
        )}
      </div>
      {!cameras.length && state.devices.status !== "error" ? (
        <div className="workspace-empty">
          <Video size={26} strokeWidth={1.25} />
          <h2>
            {state.devices.status === "loading" ||
            state.devices.status === "idle"
              ? "正在读取摄像头…"
              : "没有摄像头"}
          </h2>
          {state.devices.status === "ready" ? (
            <p>所选家庭没有可显示的摄像头。</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
