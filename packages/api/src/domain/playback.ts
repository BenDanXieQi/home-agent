import { z } from "zod";
import { apiErrorSchema } from "../contracts/errors";

export const playbackBindingSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["unbound", "installing", "ready"]) }),
  z.object({ status: z.literal("error"), error: apiErrorSchema }),
]);

export const playbackTargetSchema = z.strictObject({
  revision: z.uuid(),
  deviceId: z.string().min(1).max(128),
  channel: z.union([z.literal(1), z.literal(2)]),
});

export const playbackReservationSchema = z.object({
  id: z.uuid(),
});

export const playbackDurationSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const playbackStageTimingsSchema = z.object({
  queueMs: playbackDurationSchema.optional(),
  sourceMs: playbackDurationSchema.optional(),
  answerMs: playbackDurationSchema.optional(),
});
const observation = z.object({
  elapsedMs: playbackDurationSchema,
  sourceRecentlyActive: z.boolean(),
});
export const playbackConnectionObservationSchema = z
  .discriminatedUnion("stage", [
    observation.extend({
      stage: z.literal("queued"),
      timings: z.strictObject({}),
    }),
    observation.extend({
      stage: z.literal("connecting"),
      timings: z.strictObject({ queueMs: playbackDurationSchema }),
    }),
    observation.extend({
      stage: z.literal("signaling"),
      timings: z.strictObject({
        queueMs: playbackDurationSchema,
        sourceMs: playbackDurationSchema,
      }),
    }),
    observation.extend({
      stage: z.literal("answer_ready"),
      timings: z.strictObject({
        queueMs: playbackDurationSchema,
        sourceMs: playbackDurationSchema,
        answerMs: playbackDurationSchema,
      }),
    }),
  ])
  .refine(
    (value) =>
      Object.values(value.timings).reduce(
        (sum, duration) => sum + duration,
        0,
      ) <= value.elapsedMs,
    { message: "Completed stages exceed observed connection duration" },
  );
export type PlaybackConnectionObservation = z.infer<
  typeof playbackConnectionObservationSchema
>;

export const playbackConnectionSummarySchema = z.object({
  sourceRecentlyActive: z.boolean().nullable(),
  timings: playbackStageTimingsSchema.extend({
    prepareMs: playbackDurationSchema,
    negotiationMs: playbackDurationSchema,
  }),
});
