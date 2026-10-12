import { z } from "zod";
import type { collectorDiagnosticSchema } from "@home-agent/api/action-provenance";
import { MiCloudError } from "../protocols/micloud/errors";
import { MijiaError } from "../errors";
import { HouseholdError } from "../../household/errors";
export type CollectorDiagnostic = ReturnType<
  typeof collectorDiagnosticSchema.parse
>;
export function failure(diagnostic: CollectorDiagnostic, error: unknown) {
  diagnostic.status =
    (error instanceof MijiaError &&
      ["not_bound", "missing_credentials", "authentication"].includes(
        error.reason,
      )) ||
    (error instanceof MiCloudError &&
      ["authentication", "missing-credentials"].includes(error.code))
      ? "missing_credentials"
      : "temporarily_failed";
  diagnostic.error =
    error instanceof MiCloudError
      ? error.code
      : error instanceof MijiaError || error instanceof HouseholdError
        ? error.reason
        : error instanceof z.ZodError
          ? "invalid_source_response"
          : "storage_or_read_failed";
}
export function success(
  diagnostic: CollectorDiagnostic,
  count: number,
  limitations: string[] = [],
) {
  diagnostic.records_received = count;
  diagnostic.status = limitations.length
    ? "limited"
    : count
      ? "ready"
      : "empty";
  diagnostic.last_success_at = new Date().toISOString();
  diagnostic.error = null;
  diagnostic.limitations = [
    "history_completeness_not_guaranteed",
    ...limitations,
  ];
}
