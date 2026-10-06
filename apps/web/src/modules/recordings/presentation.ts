import { formatTime } from "../presentation/time";
import type { RecordingPlaybackState } from "./api";
import type { z } from "zod";
import type { mijiaRecordingAvailabilitySchema } from "@home-agent/api/mijia-recordings";

export const recordingLookupUnavailableText = {
  unsupported_source: "当前摄像头或镜头尚不支持 SD 录像回看。",
  not_ready: "摄像头录像尚未就绪，请稍后重试。",
  busy: "摄像头录像查询繁忙，请稍后重试。",
  timeout: "摄像头录像查询超时，请重试。",
  invalid_response: "摄像头返回的录像索引无效，请重试。",
  capacity_exceeded: "录像查询资源已满，请稍后重试。",
  connection_unavailable: "摄像头录像连接暂不可用，请稍后重试。",
  connection_reset_required: "摄像头录像连接需要恢复，请稍后重试。",
} satisfies Record<
  Extract<
    z.infer<typeof mijiaRecordingAvailabilitySchema>,
    { status: "unavailable" }
  >["reason"],
  string
>;

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

export function recordingTime(value: number) {
  return formatTime(value, "monthDayTime");
}

export function recordingDuration(value: number) {
  return `${(value / 1000).toFixed(1)} 秒`;
}
