export {
  mijiaDeviceSpecSchema,
  mijiaHomeSchema,
  type MijiaDeviceSpec,
  type MijiaHome,
  type MijiaCapability,
} from "./mijia-spec";
import { z } from "zod";
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

// Outer deadlines leave room for upstream work, error propagation and cleanup.
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

export const mijiaDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  home_id: z.string().nullable(),
  home_name: z.string().nullable(),
  room_id: z.string().nullable(),
  room_name: z.string().nullable(),
  online: z.boolean(),
  camera: z.boolean(),
  channels: z.array(z.union([z.literal(1), z.literal(2)])),
});
export const mijiaAccountSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["idle", "restoring"]) }),
  z.object({
    status: z.literal("authenticated"),
    id: z.uuid(),
    profile: z
      .object({
        name: z.string().nullable(),
        avatarUrl: z.url({ protocol: /^https$/ }).nullable(),
      })
      .nullable(),
  }),
  z.object({
    status: z.enum(["restore_error", "reauth_required"]),
    error: mijiaErrorSchema,
  }),
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

export const mijiaHomeSelectionSchema = z.object({
  selectedHomeId: z.string().nullable(),
  status: z.enum(["unselected", "selected", "unavailable"]),
  items: z.array(
    z.object({ id: z.string(), name: z.string(), shared: z.boolean() }),
  ),
});

export const mijiaStateSchema = z.object({
  homes: mijiaHomeSelectionSchema,
  revision: z.uuid(),
  connectionOperation: operationSchema.nullable(),
  account: mijiaAccountSchema,
  loginAttempt: mijiaLoginAttemptSchema,
  binding: z.discriminatedUnion("status", [
    z.object({ status: z.enum(["unbound", "installing", "ready"]) }),
    z.object({ status: z.literal("error"), error: mijiaErrorSchema }),
  ]),
  devices: z.discriminatedUnion("status", [
    z.object({
      status: z.enum(["idle", "loading", "ready"]),
      items: z.array(mijiaDeviceSchema),
    }),
    z.object({
      status: z.literal("error"),
      items: z.array(mijiaDeviceSchema),
      error: mijiaErrorSchema,
    }),
  ]),
});
export type MijiaState = z.infer<typeof mijiaStateSchema>;

export const mijiaPlaybackInputSchema = z.strictObject({
  revision: z.string().uuid(),
  sdp: z.string().min(16).max(65_536),
});
export const mijiaPlaybackReservationInputSchema = z.strictObject({
  scope_epoch: z.uuid(),
  revision: z.string().uuid(),
  deviceId: z.string().min(1).max(128),
  channel: z.union([z.literal(1), z.literal(2)]),
});
export const mijiaPlaybackReservationResponseSchema = z.object({
  id: z.string().uuid(),
});
export const mijiaPlaybackResponseSchema = z.object({
  id: z.string().uuid(),
  sdp: z.string(),
});
export type MijiaPlaybackResponse = z.infer<typeof mijiaPlaybackResponseSchema>;
export const mijiaPlaybackStateSchema = z.discriminatedUnion("phase", [
  z.object({ id: z.uuid(), phase: z.enum(["reserved", "negotiating"]) }),
  z.object({
    id: z.uuid(),
    phase: z.literal("active"),
    answer: mijiaPlaybackResponseSchema,
  }),
]);

export const mijiaVerificationInputSchema = z.strictObject({
  ticket: z.string().min(1).max(2048),
});
