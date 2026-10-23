import { z } from "zod";
import type { stateVersionSchema } from "@home-agent/api/household";
import {
  sourceKey,
  type perceptionConfigSchema,
  type sourceSelectionSchema,
} from "./config";

export const sourceAccessSchema = z.strictObject({
  endpoint: z.url(),
  sessionId: z.uuid(),
  sourceId: z.uuid(),
});

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

export function selectSources(
  config: Pick<
    z.infer<typeof perceptionConfigSchema>,
    "sources" | "sourceProfiles"
  >,
  available: z.infer<typeof sourceSelectionSchema>[],
) {
  return (config.sources === "household" ? available : config.sources).map(
    (source) => ({
      ...config.sourceProfiles.find(
        (profile) => sourceKey(profile) === sourceKey(source),
      ),
      ...source,
    }),
  );
}
