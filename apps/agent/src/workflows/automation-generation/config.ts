import { optionalModelReferenceSchema } from "../../models";

export const modelConfiguration = {
  key: "AGENT_AUTOMATION_MODEL",
  schema: optionalModelReferenceSchema,
} as const;
