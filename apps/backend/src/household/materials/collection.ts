import type {
  collectorDiagnosticSchema,
  deviceHistoryCollectionSchema,
} from "@home-agent/api/action-provenance";
import type { createRecordWriter } from "../records/writer";

/** The HTTP boundary can request collection and inspect status, not own its lifecycle. */
export type MaterialCollection = {
  collectDeviceHistory: (
    input: ReturnType<typeof deviceHistoryCollectionSchema.parse>,
  ) => Promise<ReturnType<typeof collectorDiagnosticSchema.parse>>;
  diagnostics: () => {
    collectors: ReturnType<typeof collectorDiagnosticSchema.parse>[];
    queue: ReturnType<ReturnType<typeof createRecordWriter>["diagnostics"]>;
  };
};
