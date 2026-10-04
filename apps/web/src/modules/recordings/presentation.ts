import type { z } from "zod";
import type { cameraRecordingIndexSchema } from "@home-agent/api/mijia-recordings";
import type { RecordingPlaybackState } from "./api";

export const recordingUnavailableText = {
  no_matching_recording: "未找到对应时段的 SD 录像。",
  recording_missing: "这段录像已不在摄像头的 SD 卡中。",
  unsupported_source: "当前摄像头或镜头尚不支持 SD 录像回看。",
  source_unavailable: "摄像头连接暂不可用，请稍后重试。",
  download_failed: "SD 录像读取失败，请重新申请。",
  invalid_media: "摄像头返回的录像暂时无法播放。",
  capacity_exceeded: "录像准备资源已满，请稍后重试。",

  cancelled: "录像准备已取消。",
} satisfies Record<
  Extract<RecordingPlaybackState, { state: "unavailable" }>["reason"],
  string
>;

export const recordingIndexUnavailableText = {
  unsupported_source: "当前摄像头或镜头尚不支持读取 SD 录像清单。",
  not_ready: "摄像头录像服务尚未就绪。",
  busy: "摄像头正在处理其他录像请求，请稍后重试。",
  timeout: "摄像头读取录像清单超时。",
  invalid_response: "暂时无法读取摄像头返回的录像清单。",
  capacity_exceeded: "录像清单超出本次可读取的范围。",
  connection_unavailable: "摄像头连接暂不可用。",
  connection_reset_required: "摄像头连接需要恢复后才能继续读取录像。",
} satisfies Record<
  Extract<
    z.infer<typeof cameraRecordingIndexSchema>,
    { status: "unavailable" }
  >["reason"],
  string
>;

export function recordingTime(value: number) {
  return new Date(value).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function recordingDuration(value: number) {
  return `${(value / 1000).toFixed(1)} 秒`;
}
