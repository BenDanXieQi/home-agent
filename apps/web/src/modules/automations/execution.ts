import type { AutomationRun } from "@home-agent/api/automations";

export function executionTime(at: string) {
  return new Date(at).toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

export const inputKindLabels = {
  baseline: "建立基线",
  ai: "AI 判断更新",
  facts: "设备状态更新",
  timer: "定时检查",
  event: "事件触发",
} satisfies Record<AutomationRun["input"]["kind"], string>;
