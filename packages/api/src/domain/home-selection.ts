import { z } from "zod";

export const homeSelectionSchema = z.object({
  selectedHomeId: z.string().nullable(),
  status: z.enum(["unselected", "selected", "unavailable"]),
  items: z.array(
    z.object({ id: z.string(), name: z.string(), shared: z.boolean() }),
  ),
});
