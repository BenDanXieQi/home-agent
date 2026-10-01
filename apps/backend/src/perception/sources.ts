import { z } from "zod";
import type { stateVersionSchema } from "@home-agent/api/household";
import type { sourceSelectionSchema } from "./config";

// Serializable access to the private media adapter, validated at the IPC boundary.
// Only source adapters supply it; it is never accepted from an HTTP caller.
export const sourceAccessSchema = z.strictObject({
  endpoint: z.url(),
  sessionId: z.uuid(),
  sourceId: z.uuid(),
});

// The perception application owns this input boundary. Source adapters project
// committed household access and own the lifetime of their prepared media.
export type PerceptionSources = {
  list: () => z.infer<typeof sourceSelectionSchema>[];
  eligibility: (source: z.infer<typeof sourceSelectionSchema>) => {
    scopeEpoch: z.infer<typeof stateVersionSchema>["scope_epoch"];
    householdVersion: z.infer<typeof stateVersionSchema>;
    identity: string;
  } | null;
  subscribe: (
    listener: (version: z.infer<typeof stateVersionSchema>) => void,
  ) => () => void;
  prepare: (
    source: z.infer<typeof sourceSelectionSchema>,
    signal: AbortSignal,
  ) => Promise<{
    access: z.infer<typeof sourceAccessSchema>;
    signal: AbortSignal;
  }>;
};
