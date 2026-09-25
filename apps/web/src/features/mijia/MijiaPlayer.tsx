import { Button } from "../../components/Button";
import { useState } from "react";
import { useMijiaPlayback } from "./use-mijia-playback";

function CameraPlayback({
  revision,
  deviceId,
  channel,
  name,
}: {
  revision: string;
  deviceId: string;
  channel: 1 | 2;
  name: string;
}) {
  const { videoRef, status } = useMijiaPlayback({
    revision,
    deviceId,
    channel,
  });

  return (
    <>
      <div className="mijia-video-surface">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-label={`${name} 实时画面`}
        />
        {status.phase !== "playing" ? (
          <div className="mijia-video-placeholder">
            <span aria-hidden="true">◉</span>
            <p>
              {status.phase === "error" ? "暂时无法播放" : "等待摄像头画面"}
            </p>
          </div>
        ) : null}
      </div>
      <div className="mijia-playback-status">
        <span
          className={`status-badge status-${status.phase === "playing" ? "connected" : status.phase === "error" ? "unavailable" : "unknown"}`}
        >
          <span className="status-dot" aria-hidden="true" />
          {status.phase === "playing"
            ? "实时"
            : status.phase === "error"
              ? "播放失败"
              : status.phase === "hidden"
                ? "预览不可见"
                : "等待画面"}
        </span>
        {status.phase !== "playing" ? (
          <p role={status.phase === "error" ? "alert" : "status"}>
            {status.message}
          </p>
        ) : null}
      </div>
    </>
  );
}

export function MijiaPlayer({
  revision,
  deviceId,
  channel,
  name,
  enabled,
  onEnabledChange,
}: {
  revision: string;
  deviceId: string;
  channel: 1 | 2;
  name: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <section className="mijia-player" aria-label="摄像头实时预览">
      <div className="mijia-player-heading">
        <div>
          <h3>{name}</h3>
          <p>实时预览 · 仅接收视频</p>
        </div>
        <div className="mijia-actions">
          {enabled ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => onEnabledChange(false)}
            >
              关闭播放
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setAttempt((value) => value + 1);
              onEnabledChange(true);
            }}
          >
            {enabled ? "重新播放" : "开始播放"}
          </Button>
        </div>
      </div>
      {enabled ? (
        <CameraPlayback
          key={attempt}
          revision={revision}
          deviceId={deviceId}
          channel={channel}
          name={name}
        />
      ) : (
        <div className="mijia-video-surface">
          <div className="mijia-video-placeholder">
            <p>已暂停播放</p>
          </div>
        </div>
      )}
    </section>
  );
}
