import { z } from "zod";
import { agentContextDataSchemas } from "@home-agent/api/agent-context";

export const mediaAnalysisEntrySchema =
  agentContextDataSchemas.observations.shape.media_ranges.element
    .omit({ settledAt: true, ready: true })
    .extend({
      queuedAt: z.number(),
      status: z.enum([
        "collecting",
        "queued",
        "preparing",
        "analyzing",
        "saving",
        "completed",
        "failed",
        "expired",
      ]),
      deviceName: z.string(),
      location: z.string(),
      analysisStartedAt: z.number().nullable(),
      completedAt: z.number().nullable(),
      reply: z.string().max(64 * 1024),
      reasoning: z.string().max(128 * 1024),
      error: z.string().nullable(),
      media: z.array(
        z.object({
          index: z.number().int().nonnegative(),
          kind: z.enum(["video", "audio"]),
          contentType: z.enum(["video/mp4", "audio/mp4"]),
        }),
      ),
    });

export const mediaAnalysisCompletedSchema = mediaAnalysisEntrySchema.extend({
  status: z.literal("completed"),
  completedAt: z.number(),
  reply: z
    .string()
    .min(1)
    .max(64 * 1024),
});

export const mediaAnalysisSnapshotSchema = z.object({
  enabled: z.boolean(),
  entries: z.array(
    mediaAnalysisEntrySchema
      .omit({ reply: true, reasoning: true, media: true })
      .extend({ summary: z.string() }),
  ),
});

export const mediaAnalysisInputSchema = mediaAnalysisEntrySchema
  .pick({
    source: true,
    startedAt: true,
    endedAt: true,
    kind: true,
    includeAudio: true,
  })
  .refine(
    (value) => value.startedAt < value.endedAt,
    "Media range must have positive duration",
  );
