import { z } from "zod";
import { mijiaPlaybackReservationInputSchema } from "../contracts/mijia";
import { playbackDurationSchema } from "../domain/playback";

const timestamp = z.int().nonnegative().max(4_294_967_550_000);
export const mijiaRecordingQuerySchema =
  mijiaPlaybackReservationInputSchema.safeExtend({
    afterMs: timestamp.max(4_294_967_295_000).default(0),
    limit: z.int().min(1).max(1000).default(200),
  });

export const cameraRecordingIndexSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    recordings: z
      .array(
        z
          .strictObject({
            startAt: timestamp,
            endAt: timestamp,
            event: z.boolean(),
          })
          .refine(
            (value) =>
              value.endAt > value.startAt &&
              value.endAt - value.startAt <= 255_000,
            "Invalid recording duration",
          ),
      )
      .max(1000),
    totalClips: z.int().nonnegative().max(65_536),
    discardedEntries: z.int().nonnegative().max(65_536),
    nextAfterMs: timestamp.nullable(),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum([
      "unsupported_source",
      "not_ready",
      "busy",
      "timeout",
      "invalid_response",
      "capacity_exceeded",
      "connection_unavailable",
      "connection_reset_required",
    ]),
  }),
]);

export const mijiaRecordingPlaybackInputSchema =
  mijiaPlaybackReservationInputSchema.safeExtend({
    id: z.uuid(),
    selection: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("clip"), startAt: timestamp }),
      z.strictObject({ kind: z.literal("window"), windowId: z.uuid() }),
    ]),
  });

const playbackResource = z.strictObject({
  id: z.uuid(),
  source: z.literal("sd_card"),
  deviceId: mijiaPlaybackReservationInputSchema.shape.deviceId,
  channel: mijiaPlaybackReservationInputSchema.shape.channel,
  expiresAt: timestamp,
});

export const mijiaRecordingPlaybackStateSchema = z.discriminatedUnion("state", [
  playbackResource.extend({ state: z.literal("preparing") }),
  playbackResource
    .extend({
      state: z.literal("ready"),
      fileUrl: z.string().min(1).max(256),
      actualDurationMs: playbackDurationSchema.positive(),
      segments: z
        .array(
          z
            .strictObject({
              startAt: timestamp,
              endAt: timestamp,
              mediaStartMs: playbackDurationSchema,
              mediaEndMs: playbackDurationSchema,
              timestampBasis: z.literal("device_recording"),
              gapBeforeMs: playbackDurationSchema,
            })
            .refine(
              (segment) =>
                segment.endAt > segment.startAt &&
                segment.mediaEndMs > segment.mediaStartMs,
              "Invalid recording segment",
            ),
        )
        .min(1)
        .max(64),
      alignment: z.discriminatedUnion("type", [
        z.strictObject({
          type: z.literal("confirmed"),
          basis: z.literal("frame_offset"),
          seekOffsetMs: playbackDurationSchema,
          uncertaintyMs: playbackDurationSchema,
        }),
        z.strictObject({
          type: z.literal("unknown"),
          reason: z.enum([
            "clip_selected",
            "no_frame_mapping",
            "clock_unverified",
          ]),
        }),
      ]),
      eventFrameOffsets: z
        .array(
          z.strictObject({
            sequence: z.int().positive(),
            offsetMs: playbackDurationSchema,
            uncertaintyMs: playbackDurationSchema,
          }),
        )
        .max(5),
    })
    .refine(
      (resource) =>
        resource.fileUrl ===
          `/api/mijia/recordings/playback/${resource.id}/media` &&
        resource.segments.every(
          (segment, index, segments) =>
            segment.mediaEndMs <= resource.actualDurationMs &&
            (index === 0 ||
              segment.mediaStartMs >= segments[index - 1]!.mediaEndMs),
        ) &&
        resource.eventFrameOffsets.every(
          (frame) => frame.offsetMs < resource.actualDurationMs,
        ) &&
        (resource.alignment.type === "confirmed"
          ? resource.alignment.seekOffsetMs < resource.actualDurationMs
          : resource.eventFrameOffsets.length === 0),
      "Invalid recording playback mapping",
    ),
  playbackResource.extend({
    state: z.literal("unavailable"),
    reason: z.enum([
      "no_matching_recording",
      "recording_missing",
      "unsupported_source",
      "source_unavailable",
      "download_failed",
      "invalid_media",
      "capacity_exceeded",
      "cancelled",
    ]),
  }),
  playbackResource.extend({ state: z.literal("expired") }),
  playbackResource.extend({ state: z.literal("revoked") }),
]);
