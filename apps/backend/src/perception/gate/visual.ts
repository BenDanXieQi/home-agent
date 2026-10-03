import type { z } from "zod";
import type { windowBoxSchema } from "@home-agent/api/contracts";
import { windowLimits } from "../window/limits";

// Domain threshold: strictly greater than 25, at least 0.5% of gray pixels.
export function visualDifference(previous: Uint8Array, current: Uint8Array) {
  if (
    previous.length !== windowLimits.graySide ** 2 ||
    current.length !== previous.length
  )
    throw new Error("Invalid visual gate frame");
  let count = 0,
    left: number = windowLimits.graySide,
    top: number = windowLimits.graySide,
    right = 0,
    bottom = 0;
  for (let i = 0; i < current.length; i++) {
    if (Math.abs(current[i]! - previous[i]!) <= 25) continue;
    count++;
    const x = i % windowLimits.graySide,
      y = Math.floor(i / windowLimits.graySide);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + 1);
    bottom = Math.max(bottom, y + 1);
  }
  return {
    ratio: count / current.length,
    region: count
      ? {
          x: left / windowLimits.graySide,
          y: top / windowLimits.graySide,
          w: (right - left) / windowLimits.graySide,
          h: (bottom - top) / windowLimits.graySide,
        }
      : null,
  };
}

export function selectCrop(regions: z.infer<typeof windowBoxSchema>[]) {
  if (!regions.length) return null;
  const left = Math.max(0, Math.min(...regions.map((box) => box.x)));
  const top = Math.max(0, Math.min(...regions.map((box) => box.y)));
  const right = Math.min(1, Math.max(...regions.map((box) => box.x + box.w)));
  const bottom = Math.min(1, Math.max(...regions.map((box) => box.y + box.h)));
  let w = (right - left) * 1.8,
    h = (bottom - top) * 1.6;
  if (w <= 0 || h <= 0) return null;
  const growth = Math.max(1, Math.sqrt(0.1 / (w * h)));
  w = Math.min(1, w * growth);
  h = Math.min(1, h * growth);
  if (w * h > 0.49 || w * h < 0.1) return null;
  return {
    x: Math.max(0, Math.min(1 - w, (left + right - w) / 2)),
    y: Math.max(0, Math.min(1 - h, (top + bottom - h) / 2)),
    w,
    h,
  };
}

export function evaluateScene(input: {
  hasVideo: boolean;
  failed: boolean;
  first: boolean;
  changedRatio: number;
  audioPassed: boolean;
}) {
  const changed =
    input.hasVideo && !input.failed && input.changedRatio >= 0.005;
  const visual = input.failed
    ? ("failed" as const)
    : !input.hasVideo
      ? ("missing" as const)
      : changed
        ? ("changed" as const)
        : input.first
          ? ("first" as const)
          : ("static" as const);
  const candidate =
    visual === "changed" ? ("video" as const) : ("none" as const);
  return {
    gate: {
      candidate,
      visual,
      changedRatio: input.changedRatio,
      holdUntil: null,
      audioPassed: input.audioPassed,
    },
  };
}
