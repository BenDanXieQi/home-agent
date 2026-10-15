import { inventoryDeviceSchema } from "../domain/devices";
import { homeSelectionSchema } from "../domain/home-selection";
import { accountSessionStateSchema } from "../domain/account-session";
import { sourceMediaSchema } from "./media";
export { mijiaDeviceSpecSchema, type MijiaDeviceSpec } from "./mijia-spec";
import { z } from "zod";
import {
  playbackConnectionSummarySchema,
  playbackTargetSchema,
  playbackBindingSchema,
} from "../domain/playback";
import { operationSchema } from "./operations";
import { apiErrorSchema } from "./errors";
import { mijiaErrorCodes } from "./mijia-errors";
export {
  isMijiaFailureReason,
  isMijiaErrorCode,
  mijiaFailureMessage,
  type MijiaErrorCode,
  type MijiaFailureReason,
} from "./mijia-errors";

export const mijiaErrorSchema = apiErrorSchema.extend({
  code: z.enum(mijiaErrorCodes),
});
export type MijiaErrorDetails = z.infer<typeof mijiaErrorSchema>;

export const mijiaTimeouts = {
  control: 15_000,
  devices: 20_000,
  verification: 120_000,
  playback: 70_000,
  negotiation: 85_000,
  iceGathering: 10_000,
  firstFrame: 20_000,
  stalledFrame: 8_000,
  upstream: 10_000,
  install: 45_000,
  signaling: 55_000,
} as const;

export const mijiaAccountSchema = z.discriminatedUnion("status", [
  accountSessionStateSchema.options[0],
  accountSessionStateSchema.options[1],
  accountSessionStateSchema.options[2].extend({ error: mijiaErrorSchema }),
]);
export const mijiaLoginAttemptSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }),
  z.object({ status: z.literal("creating"), id: z.uuid() }),
  z.object({
    status: z.literal("pending"),
    id: z.uuid(),
    qrImageUrl: z.string(),
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    status: z.literal("security_required"),
    id: z.uuid(),
    verificationUrl: z.url(),
    expiresAt: z.iso.datetime(),
    error: mijiaErrorSchema.optional(),
  }),
  z.object({ status: z.literal("completing"), id: z.uuid() }),
  z.object({ status: z.literal("completed"), id: z.uuid() }),
  z.object({
    status: z.enum(["expired", "error"]),
    id: z.uuid(),
    error: mijiaErrorSchema,
  }),
  z.object({ status: z.literal("cancelled"), id: z.uuid() }),
]);
export type MijiaLoginAttempt = z.infer<typeof mijiaLoginAttemptSchema>;

export function isMijiaLoginAttemptActive(
  attempt: Pick<MijiaLoginAttempt, "status"> | undefined,
) {
  return (
    attempt !== undefined &&
    (attempt.status === "creating" ||
      attempt.status === "pending" ||
      attempt.status === "security_required" ||
      attempt.status === "completing")
  );
}

export const mijiaStateSchema = z.object({
  homes: homeSelectionSchema,
  revision: z.uuid(),
  connectionOperation: operationSchema.nullable(),
  account: mijiaAccountSchema,
  loginAttempt: mijiaLoginAttemptSchema,
  binding: z.discriminatedUnion("status", [
    playbackBindingSchema.options[0],
    playbackBindingSchema.options[1].extend({ error: mijiaErrorSchema }),
  ]),
  devices: z.discriminatedUnion("status", [
    z.object({
      status: z.enum(["idle", "loading", "ready"]),
      items: z.array(inventoryDeviceSchema),
    }),
    z.object({
      status: z.literal("error"),
      items: z.array(inventoryDeviceSchema),
      error: mijiaErrorSchema,
    }),
  ]),
});
export type MijiaState = z.infer<typeof mijiaStateSchema>;

export const mijiaPlaybackInputSchema = z.strictObject({
  revision: z.string().uuid(),
  sdp: z.string().min(16).max(65_536),
});
export const mijiaPlaybackReservationInputSchema =
  playbackTargetSchema.safeExtend({
    scope_epoch: z.uuid(),
  });
export const mijiaPlaybackResponseSchema = z.object({
  id: z.string().uuid(),
  sdp: z.string(),
  connection: playbackConnectionSummarySchema,
  media: sourceMediaSchema,
});
export type MijiaPlaybackResponse = z.infer<typeof mijiaPlaybackResponseSchema>;
export const mijiaPlaybackStateSchema = z.discriminatedUnion("phase", [
  z.object({
    id: z.uuid(),
    phase: z.enum(["reserved", "negotiating"]),
  }),
  z.object({
    id: z.uuid(),
    phase: z.literal("active"),
    answer: mijiaPlaybackResponseSchema,
  }),
]);

export const mijiaVerificationInputSchema = z.strictObject({
  ticket: z.string().min(1).max(2048),
});
