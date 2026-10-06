import { resolveComputeBudget } from "./budget";
import type { z } from "zod";
import type { perceptionConfigSchema } from "../config";

// Reservations bound admitted model capacity, not OS RSS or decoder CPU usage.
// ReID borrows a video CPU slot but has its own resident model allocation.
const modelMemoryMiB = Object.freeze({
  detection: 384,
  tracking: 256,
  vad: 128,
  petSounds: 256,
  speech: 1536,
  identity: 768,
});

export function planPerceptionResources(
  config: z.infer<typeof perceptionConfigSchema>,
) {
  const host = resolveComputeBudget(config.cpuRatio);
  const audioEnabled =
    config.sources === "household" || config.sources.length > 0;
  const audioThreads = audioEnabled ? 1 : 0;
  const speechThreads = audioEnabled && config.speech.enabled ? 1 : 0;
  const petSoundThreads = audioEnabled && config.petSounds.enabled ? 1 : 0;
  const identityThreads = config.identity !== null ? 1 : 0;
  // Continuous capture keeps one detector and one VAD lane even on a tiny share.
  // Optional analysis must fit beyond that minimum; it cannot raise the budget itself.
  const nativeThreads = Math.max(1 + audioThreads, host.workersPerProcess);
  const audioMemory =
    audioThreads * modelMemoryMiB.vad +
    speechThreads * modelMemoryMiB.speech +
    petSoundThreads * modelMemoryMiB.petSounds;
  const identityMemory = identityThreads * modelMemoryMiB.identity;
  const remainingMemory = config.modelMemoryMiB - audioMemory - identityMemory;
  const remainingThreads =
    nativeThreads - audioThreads - speechThreads - petSoundThreads;
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
      "Perception resource budget cannot fit video, VAD and enabled sound/speech models; increase cpuRatio or modelMemoryMiB, or disable an optional model",
    );
  if (identityThreads && videoWorkers < 3)
    throw new Error(
      "Enabled identity recognition requires three video CPU slots and memory for detection, ReID and face models after VAD/ASR reservations; increase cpuRatio or modelMemoryMiB, or disable an optional model",
    );
  return {
    nativeThreads,
    videoWorkers,
    audioThreads,
    speechThreads,
    petSoundThreads,
    identityThreads,
    modelMemoryMiB: config.modelMemoryMiB,
    reservedModelMiB:
      audioMemory +
      identityMemory +
      trackingMemory +
      videoWorkers * modelMemoryMiB.detection,
  };
}
