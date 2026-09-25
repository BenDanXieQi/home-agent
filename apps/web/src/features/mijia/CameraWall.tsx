import { memo, useCallback, useState } from "react";
import { Video, VideoOff } from "lucide-react";
import type { MijiaState } from "@home-agent/api/mijia";
import { MijiaPlayer } from "./MijiaPlayer";

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
  state: MijiaState;
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
  const cameras = state.devices.items.filter((device) => device.camera);
  const offlineCameras = cameras.filter(
    (device) => !device.online && device.retainedChannels.length === 0,
  );
  return (
    <>
      <div className="camera-wall">
        {cameras.flatMap((device) =>
          (device.online ? device.channels : device.retainedChannels).map(
            (channel) => (
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
            ),
          ),
        )}
      </div>
      {offlineCameras.length ? (
        <section className="offline-cameras" aria-label="离线摄像头">
          <h2>
            离线设备 <span>{offlineCameras.length}</span>
          </h2>
          <ul>
            {offlineCameras.map((device) => (
              <li key={device.id}>
                <VideoOff size={15} strokeWidth={1.5} aria-hidden="true" />
                <span className="offline-camera-name" title={device.name}>
                  {device.name}
                </span>
                <span className="offline-camera-status">离线</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
            <p>当前米家账号下没有可显示的摄像头。</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
