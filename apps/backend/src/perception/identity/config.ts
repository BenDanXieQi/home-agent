import { identityCapacity } from "@home-agent/api/contracts";
import profile from "./profile.json";
import { z } from "zod";

// Native paths stay in backend configuration and never enter public snapshots.
export const identityConfigSchema = z
  .strictObject({
    python: z.string().min(1),
    modelDirectory: z.string().min(1),
    galleryFile: z.string().min(1).nullable().default(null),
    sampleIntervalMs: z.int().min(500).max(10_000).default(1000),
    evidenceTtlMs: z.int().min(5000).max(120_000).default(30_000),
    idleUnloadMs: z.int().min(1000).max(300_000).default(30_000),
    minimumSharpness: z
      .number()
      .nonnegative()
      .max(10_000)
      .default(profile.minimumSharpness),
  })
  .refine(
    (value) => value.evidenceTtlMs >= value.sampleIntervalMs * 3,
    "Evidence retention must cover at least three sampling intervals",
  );

export const identityLimits = {
  ...identityCapacity,
  minimumConfirmations: 3,
  recentTtlMs: 60_000,
  requestTimeoutMs: 1500,
  startupTimeoutMs: 30_000,
  restartDelayMs: 5000,
} as const;
