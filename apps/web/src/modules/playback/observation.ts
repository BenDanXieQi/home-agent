import type { z } from "zod";
import { memberActivityDataSchema } from "@home-agent/api/contracts";

export const observationPlaybackSourceSchema = memberActivityDataSchema.pick({
  deviceId: true,
  channel: true,
  sourceRunId: true,
  firstObservedAt: true,
  lastObservedAt: true,
});

export function memberObservationPlaybackSource(
  data: z.infer<typeof memberActivityDataSchema>,
) {
  const current = data.attribution.current;
  const evidence =
    current.kind === "known"
      ? current
      : (data.attribution.lastCorrection?.before ?? data.attribution.original);
  const observedAt =
    evidence.kind === "known"
      ? evidence.association.observedAt
      : data.lastObservedAt;
  return observationPlaybackSourceSchema.parse({
    ...data,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
  });
}
