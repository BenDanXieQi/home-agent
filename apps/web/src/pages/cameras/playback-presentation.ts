import { mijiaTimeouts } from "@home-agent/api/mijia";
import type { estimateRemainingPlaybackTime } from "../../modules/playback/estimates";
import { RequestError } from "../../api/errors";
import { requestErrorMessage } from "../../messages/zh-CN";
import type { PlaybackSession } from "../../modules/playback/session";

export const playbackBadgeTones = {
  connected: "text-sage [&_.status-dot]:status-ping",
  unavailable: "text-danger",
  unknown: "text-muted",
};

const failures = {
  unsupported_browser:
    "当前浏览器缺少 WebRTC 或视频出帧检测能力，请使用现代浏览器打开本机页面。",
  negotiation_timeout: `${mijiaTimeouts.negotiation / 1_000} 秒内未能完成播放协商，请检查摄像头与本机网络后重试。`,
  track_ended: "摄像头视频轨道已结束，请重新播放。",
  autoplay_failed: "浏览器未能开始播放视频，请点击重新播放。",
  connection_failed:
    "WebRTC 连接失败，请检查 go2rtc 的 8555 端口及本机候选地址。",
  first_frame_timeout: `${mijiaTimeouts.firstFrame / 1_000} 秒内没有收到可显示的首帧。请确认摄像头在线、视频编码受浏览器支持，并重试。`,
  stalled_frame: `摄像头画面已连续 ${mijiaTimeouts.stalledFrame / 1_000} 秒没有更新，播放已停止。请检查设备和网络后重新播放。`,
  negotiation_failed: "播放协商失败，请检查摄像头和浏览器连接后重试。",
} satisfies Record<
  Exclude<
    ReturnType<PlaybackSession["getSnapshot"]>["failure"],
    RequestError | null
  >,
  string
>;

export function playbackPresentation(
  snapshot: ReturnType<PlaybackSession["getSnapshot"]>,
) {
  if (snapshot.phase === "playing")
    return {
      label: "实时",
      message: "已收到并显示摄像头画面",
      tone: "connected" as const,
    };
  if (snapshot.phase === "error")
    return {
      label: "播放失败",
      message:
        snapshot.failure instanceof RequestError
          ? requestErrorMessage(snapshot.failure)
          : failures[snapshot.failure ?? "negotiation_failed"],
      tone: "unavailable" as const,
    };
  if (snapshot.phase === "hidden")
    return {
      label: "预览不可见",
      message: "预览当前不可见，恢复可见后继续检测画面。",
      tone: "unknown" as const,
    };
  if (snapshot.firstFrameAt !== null)
    return {
      label: "恢复画面",
      message: "正在恢复画面…",
      tone: "unknown" as const,
    };
  return {
    ...(snapshot.answerAppliedAt !== null
      ? { label: "等待画面", message: "正在接收摄像头画面…" }
      : { label: "连接中", message: "正在建立播放连接…" }),
    tone: "unknown" as const,
  };
}

export function remainingPlaybackTime(
  estimate: NonNullable<ReturnType<typeof estimateRemainingPlaybackTime>>,
) {
  const lower = Math.floor(estimate.lowerMs / 1_000);
  const upper = Math.ceil(estimate.upperMs / 1_000);
  if (estimate.upperMs < 1_000) return "通常还需不到 1 秒";
  if (lower === upper) return `通常还需约 ${upper} 秒`;
  return `通常还需约 ${lower}–${upper} 秒`;
}
