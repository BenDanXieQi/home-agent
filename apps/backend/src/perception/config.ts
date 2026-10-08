import {
  windowPolicySchema,
  petSoundConfigSchema,
  cameraVideoQualitySchema,
} from "@home-agent/api/contracts";
import { identityConfigSchema } from "./identity/config";
import { speechDialogueConfigSchema } from "@home-agent/api/speech-dialogue";
import { speechConfigSchema } from "@home-agent/api/contracts";
import { cpuRatioSchema } from "./compute/budget";
import { z } from "zod";

export const sourceSelectionSchema = z.strictObject({
  deviceId: z.string().regex(/^[0-9]{1,32}$/),
  channel: z.union([z.literal(1), z.literal(2)]),
  videoQuality: cameraVideoQualitySchema.optional(),
});
export const perceptionConfigSchema = z
  .strictObject({
    cpuRatio: cpuRatioSchema,
    window: windowPolicySchema.default(() => windowPolicySchema.parse({})),
    identity: identityConfigSchema.nullable().default(null),
    dialogue: speechDialogueConfigSchema.prefault({}),
    modelMemoryMiB: z.int().min(512).max(131072).default(4096),
    speech: speechConfigSchema.prefault({}),
    petSounds: petSoundConfigSchema.prefault({}),
    sources: z
      .union([z.literal("household"), z.array(sourceSelectionSchema).max(8)])
      .default([]),
    sourceProfiles: z
      .array(sourceSelectionSchema.required({ videoQuality: true }))
      .max(8)
      .default([]),
    sampleFps: z.number().positive().max(30).default(3),
    firstFrameTimeoutMs: z.int().min(100).max(300_000).default(90_000),
    silenceTimeoutMs: z.int().min(100).max(300_000).default(30_000),
    maxFrameAgeMs: z.int().min(100).max(30_000).default(2_000),
  })
  .refine(
    (config) => !config.dialogue.enabled || config.speech.enabled,
    "Dialogue requires speech transcription",
  )
  .refine(
    (config) =>
      new Set(config.sourceProfiles.map(sourceKey)).size ===
      config.sourceProfiles.length,
    "Duplicate camera channel profile",
  )
  .refine(
    (config) => config.silenceTimeoutMs > 1000 / config.sampleFps,
    "Silence timeout must exceed the sampling interval",
  )
  .refine(
    (config) =>
      config.sources === "household" ||
      new Set(config.sources.map(sourceKey)).size === config.sources.length,
    "Duplicate camera channel",
  );
export function sourceKey(source: z.infer<typeof sourceSelectionSchema>) {
  return `${source.deviceId}:${source.channel}`;
}
