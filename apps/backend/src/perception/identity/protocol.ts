import { identityClassSchema } from "../../household/identity/contracts";
import { z } from "zod";
import { trackingObservationSchema } from "@home-agent/api/contracts";
import { identityLimits } from "./config";
import { enrollmentResultSchema } from "./enrollment-protocol";
import { identityEvidenceSchema } from "./evidence";
import profile from "./profile.json";

export const identityPrepareSchema = z
  .object({
    kind: z.literal("prepare"),
    classes: z.array(identityClassSchema).max(3),
    attributes: z.boolean().optional(),
  })
  .refine((request) => request.classes.length > 0 || request.attributes);

const pixels = z.object({
  rgb: z
    .instanceof(Uint8Array)
    .refine((bytes) => bytes.byteLength === profile.width * profile.height * 3),
});
const measuredTracks = z
  .array(
    trackingObservationSchema.shape.tracks.element
      .pick({ trackId: true, className: true, measuredBox: true })
      .extend({
        measuredBox:
          trackingObservationSchema.shape.tracks.element.shape.measuredBox.unwrap(),
      }),
  )
  .max(identityLimits.tracksPerRun);
export const identityRequestSchema = z.discriminatedUnion("kind", [
  pixels.extend({
    kind: z.literal("tracking"),
    attributeTargets: z
      .array(z.int().positive())
      .max(identityLimits.targetsPerFrame)
      .optional(),
    tracks: measuredTracks,
    targets: z.array(z.int().positive()).max(identityLimits.targetsPerFrame),
  }),
  pixels.extend({
    kind: z.literal("photo"),
    className: identityClassSchema,
    tracks: measuredTracks,
  }),
  pixels.extend({
    kind: z.literal("video_frame"),
    className: identityClassSchema,
    tracks: measuredTracks,
  }),
]);
export const identityResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), version: z.string() }),
  z.object({ kind: z.literal("failed"), error: z.string().max(4096) }),
  z.object({ kind: z.literal("unavailable"), error: z.string().max(4096) }),
  z.object({
    kind: z.literal("prepared"),
    attributesAvailable: z.boolean().optional(),
    attributeError: z.string().max(4096).optional(),
    available: z.array(identityClassSchema).max(3),
    failures: z
      .array(
        z.object({
          className: identityClassSchema,
          error: z.string().max(4096),
        }),
      )
      .max(3),
  }),
  enrollmentResultSchema,
  identityEvidenceSchema.extend({
    kind: z.literal("result"),
    attributeError: z.string().max(4096).optional(),
    failures: z
      .array(
        z.object({
          className: identityClassSchema,
          error: z.string().max(4096),
        }),
      )
      .max(3),
  }),
]);
