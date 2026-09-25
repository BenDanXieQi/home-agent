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
  online: z.boolean(),
  camera: z.boolean(),
  channels: z.array(z.union([z.literal(1), z.literal(2)])),
  retainedChannels: z.array(z.union([z.literal(1), z.literal(2)])),
});
export const mijiaAccountSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["idle", "restoring"]) }),
  z.object({ status: z.literal("authenticated"), id: z.uuid() }),
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
  attempt: MijiaLoginAttempt | undefined,
): attempt is Extract<
  MijiaLoginAttempt,
  { status: "creating" | "pending" | "security_required" | "completing" }
> {
  return (
    attempt !== undefined &&
    ["creating", "pending", "security_required", "completing"].includes(
      attempt.status,
    )
  );
}

export const mijiaStateSchema = z.object({
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

/** Poll cadence is advertised by the server through Retry-After on every snapshot. */
export function mijiaPollIntervalMs(state: MijiaState) {
  if (
    state.connectionOperation?.status === "running" ||
    isMijiaLoginAttemptActive(state.loginAttempt) ||
    state.account.status === "restoring" ||
    state.binding.status === "installing" ||
    state.devices.status === "loading"
  )
    return 2_000;
  return state.account.status === "idle" &&
    ["idle", "cancelled"].includes(state.loginAttempt.status)
    ? 30_000
    : 10_000;
}

export const mijiaVerificationInputSchema = z.strictObject({
  ticket: z.string().min(1).max(2048),
});
