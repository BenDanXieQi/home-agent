import { z } from "zod";
import { apiErrorSchema } from "../contracts/errors";

export const accountSessionStateSchema = z.discriminatedUnion("status", [
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
    error: apiErrorSchema,
  }),
]);
