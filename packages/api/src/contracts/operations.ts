import { z } from "zod";
import { apiErrorSchema } from "./errors";

const operationIdentity = {
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const operationSchema = z.discriminatedUnion("status", [
  z.object({
    ...operationIdentity,
    status: z.enum(["running", "succeeded", "cancelled"]),
  }),
  z.object({
    ...operationIdentity,
    status: z.literal("failed"),
    error: apiErrorSchema,
  }),
]);
export type Operation = z.infer<typeof operationSchema>;
