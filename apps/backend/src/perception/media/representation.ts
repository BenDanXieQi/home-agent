import type { z } from "zod";
import type { windowSummarySchema } from "@home-agent/api/contracts";

export function representationParameters(
  summary: Pick<
    z.infer<typeof windowSummarySchema>,
    "audio" | "startedAt" | "endedAt"
  >,
) {
  return {
    timestampBasis: "host_receive" as const,
    audioIncluded: summary.audio.status === "available",
    startedAt: summary.audio.startedAt ?? summary.startedAt,
    endedAt: summary.audio.endedAt ?? summary.endedAt,
  };
}
