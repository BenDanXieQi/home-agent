import { formatTime } from "../presentation/time";
import type { WindowListEntry } from "./windows";
import type { projectWindowMaterial } from "@home-agent/api/perception/window-observations";

export const visualReasons = {
  first: "首个有效画面窗口",
  changed: "画面发生变化",
  hold: "变化后继续放行",
  static: "画面静止",
  missing: "缺少视频帧",
  failed: "视觉筛选失败",
};
export const representations = {
  image: "全景图片",
  crop_image: "裁切图片",
  video: "全景视频",
  crop_video: "裁切视频",
  audio: "声音",
};
export function windowTime(time: number) {
  return formatTime(time, "clock");
}
export function candidateLabel(window: Pick<WindowListEntry, "gate">) {
  return { video: "画面变化", audio: "声音片段", none: "仅文字" }[
    window.gate.candidate
  ];
}

export const mediaStates = {
  queued: "等待生成",
  generating: "正在生成",
  ready: "可播放",
  failed: "生成失败",
  not_generated: "尚未生成",
  expired: "回看已过期",
  evicted: "已清理",
  revoked: "访问已撤销",
};

export function mediaStateLabel(
  state:
    | NonNullable<WindowListEntry["sampledMedia"]>["state"]
    | null
    | undefined,
) {
  return state ? mediaStates[state] : "无媒体引用";
}

export function petSoundSummary(
  material: Pick<
    ReturnType<typeof projectWindowMaterial>,
    "pet_sound_analysis" | "pet_sound_count"
  >,
) {
  const analysis = material.pet_sound_analysis;
  if (!analysis) return "未提供分析结果";
  if (analysis.status !== "ready") return petSoundStatuses[analysis.status];
  if (analysis.validity !== "valid")
    return {
      no_data: "未获得分析结果",
      expired: "分析结果已过期",
      unavailable: "分析结果不可用",
    }[analysis.validity];
  return `${petSoundStatuses.ready} · ${material.pet_sound_count} 条检测结果`;
}

export const historicalIdentityStatuses = {
  idle: "当时未采样",
  starting: "当时模型尚未就绪",
  unloading: "当时模型在释放中",
  collecting: "当时仅采集人脸证据",
  recognizing: "当时已启用参考匹配",
  unavailable: "当时身份分析不可用",
  disabled: "当时未启用身份分析",
};

export const identityStates = {
  unknown: "未知",
  candidate: "候选",
  confirmed: "本地已确认",
  conflict: "证据冲突",
};

export const identityReasons = new Map([
  ["no_reference_gallery", "未配置参考资料"],
  ["conflicting_face_evidence", "人脸证据互相冲突"],
  ["repeated_face_support", "多次人脸证据支持同一标签"],
  ["insufficient_support", "支持证据尚不足"],
  ["below_identity_threshold", "身份分数或分差未达到阈值"],
  ["no_fresh_face", "缺少有效的人脸证据"],
]);

export const petSoundLabels = { dog: "狗声", cat: "猫声" };
export const petSoundStatuses = {
  insufficient_input: "等待完整声音窗口",
  ready: "分类可用",
  unavailable: "分类不可用",
};

export const windowInputStates = {
  available: "可用",
  expired: "已过期",
  evicted: "已清理",
  revoked: "访问已撤销",
};
export const windowAudioStates = {
  available: "可用",
  no_track: "无音轨",
  missing: "缺失",
  insufficient_input: "输入不足",
  failed: "失败",
};
export const windowVadStates = {
  speech: "检出人声",
  no_speech: "未检出人声",
  insufficient_input: "输入不足",
  unavailable: "不可用",
};
