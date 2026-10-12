import { provenancePolicy } from "@home-agent/api/action-provenance";
import { z } from "zod";

/** Retention belongs to household records, independently of their producer. */
export const recordRetentionConfigSchema = z.object({
  retention_days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(provenancePolicy.retentionDays),
  conversation_retention_days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(provenancePolicy.conversationRetentionDays),
});
