import { optionalModelReferenceSchema } from "../../models";

export const modelConfiguration = {
  key: "AGENT_SPATIAL_MODEL",
  schema: optionalModelReferenceSchema,
} as const;
