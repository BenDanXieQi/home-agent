import {
  supplierMaterialSchema,
  provenancePolicy,
} from "@home-agent/api/action-provenance";
import { HouseholdError } from "../../household/errors";
import type { accessHousehold } from "../../household/access";
import type { createRecordWriter } from "../../household/records/writer";
import type { createMaterialRepository } from "../../household/materials/repository";
import type { recordRetentionConfigSchema } from "../../household/records/config";
import { providerPayload } from "../protocols/source-metadata";

/** Sanitize every stored field, including structured answers and event arguments. */
export function createMaterialStorage(deps: {
  writer: ReturnType<typeof createRecordWriter>;
  repository: ReturnType<typeof createMaterialRepository>;
  retention: ReturnType<typeof recordRetentionConfigSchema.parse>;
  signal: AbortSignal;
}) {
  return async (
    scope: ReturnType<typeof accessHousehold>,
    material: ReturnType<typeof supplierMaterialSchema.parse>,
    receivedAt = new Date().toISOString(),
  ) => {
    const assertCurrent = () => {
      deps.signal.throwIfAborted();
      scope.assertCurrent();
    };
    assertCurrent();
    const sanitized = providerPayload(material, provenancePolicy.recordBytes);
    if (sanitized.omitted) throw new HouseholdError("capacity_exceeded");
    const data = supplierMaterialSchema.parse(sanitized.payload);
    if (sanitized.redacted) {
      if (data.source.completeness === "received_fields")
        data.source.completeness = "partial";
      data.source.limitations = [
        ...new Set([...data.source.limitations, "provider_fields_redacted"]),
      ];
    }
    const submission = {
      id: crypto.randomUUID(),
      received_at: receivedAt,
      data,
    };
    return deps.writer.submit(submission, () => {
      assertCurrent();
      return deps.repository.save(
        { ...scope, assertCurrent },
        submission,
        data.topic === "xiaoai_conversation"
          ? deps.retention.conversation_retention_days
          : deps.retention.retention_days,
      );
    });
  };
}
