import type { WindowListEntry } from "../../modules/perception/windows";

const windowClock = new Intl.DateTimeFormat("zh-CN", {
  timeStyle: "medium",
  hour12: false,
});

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
  return windowClock.format(time);
}
export function candidateLabel(window: WindowListEntry) {
  return { video: "视觉通过", audio: "声音通过", none: "跳过" }[
    window.gate.candidate
  ];
}

export const recordingStates = {
  queued: "等待生成",
  generating: "正在生成",
  ready: "可播放",
  failed: "生成失败",
  not_generated: "尚未生成",
  expired: "回看已过期",
  evicted: "已清理",
  revoked: "访问已撤销",
};
