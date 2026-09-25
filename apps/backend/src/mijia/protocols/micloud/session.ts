import { z } from "zod";

/** Portable session data; persistence and encryption belong to the backend. */
export const savedSessionSchema = z.strictObject({
  region: z.literal("cn"),
  userId: z.string().regex(/^[0-9]{1,32}$/),
  passToken: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[^;\r\n]+$/)
    .refine((value) => !value.includes(String.fromCharCode(0))),
  ssecurity: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  serviceToken: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[^;\r\n]+$/)
    .refine((value) => !value.includes(String.fromCharCode(0))),
  expiresAt: z.number().finite().nullable(),
  clientId: z.string().regex(/^[A-Za-z]{6}$/),
  userAgent: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\r\n]+$/)
    .refine((value) => !value.includes(String.fromCharCode(0))),
});

export type MiCloudSavedSession = z.infer<typeof savedSessionSchema>;
