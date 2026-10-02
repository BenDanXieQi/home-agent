import { resolveComputeBudget } from "./budget";
import type { z } from "zod";
import type { perceptionConfigSchema } from "../config";

// Reservations bound admitted model capacity, not OS RSS or decoder CPU usage.
// ReID borrows a video CPU slot but has its own resident model allocation.
const modelMemoryMiB = Object.freeze({
  detection: 384,
  tracking: 256,
  vad: 128,
  speech: 1536,
});

export function planPerceptionResources(
  config: z.infer<typeof perceptionConfigSchema>,
) {
  const host = resolveComputeBudget(config.cpuRatio);
  const audioEnabled =
    config.sources === "household" || config.sources.length > 0;
  const audioThreads = audioEnabled ? 1 : 0;
  const speechThreads = audioEnabled && config.speech.enabled ? 1 : 0;
  // Continuous capture keeps one detector and one VAD lane even on a tiny share.
  // Optional ASR must fit beyond that minimum; it cannot raise the budget itself.
  const nativeThreads = Math.max(1 + audioThreads, host.workersPerProcess);
  const audioMemory =
    audioThreads * modelMemoryMiB.vad + speechThreads * modelMemoryMiB.speech;
  const remainingMemory = config.modelMemoryMiB - audioMemory;
  const remainingThreads = nativeThreads - audioThreads - speechThreads;
  const trackingAvailable =
    audioEnabled &&
    remainingThreads >= 2 &&
    remainingMemory >= 2 * modelMemoryMiB.detection + modelMemoryMiB.tracking;
  const trackingMemory = trackingAvailable ? modelMemoryMiB.tracking : 0;
  const videoWorkers = Math.min(
    remainingThreads,
    Math.floor((remainingMemory - trackingMemory) / modelMemoryMiB.detection),
    audioEnabled && !trackingAvailable ? 1 : remainingThreads,
  );
  if (videoWorkers < 1)
    throw new Error(
      "Perception resource budget cannot fit video, VAD and enabled ASR; increase cpuRatio or modelMemoryMiB, or disable speech",
    );
  return {
    nativeThreads,
    videoWorkers,
    audioThreads,
    speechThreads,
    modelMemoryMiB: config.modelMemoryMiB,
    reservedModelMiB:
      audioMemory + trackingMemory + videoWorkers * modelMemoryMiB.detection,
  };
}
