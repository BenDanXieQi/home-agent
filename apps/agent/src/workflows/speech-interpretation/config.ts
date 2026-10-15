import { optionalModelReferenceSchema } from "../../models";

export const modelConfiguration = {
  key: "AGENT_SPEECH_MODEL",
  schema: optionalModelReferenceSchema,
} as const;
