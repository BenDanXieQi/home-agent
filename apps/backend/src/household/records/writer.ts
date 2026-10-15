import { provenancePolicy } from "@home-agent/api/action-provenance";
import PQueue from "p-queue";
import { jsonBytes } from "../config";
import { HouseholdError } from "../errors";

export function createRecordWriter() {
  const queue = new PQueue({ concurrency: 1 });
  let bytes = 0;
  let closed = false;
  const counts = { saved: 0, failed: 0, dropped: 0 };
  return {
    async submit<T>(payload: unknown, save: () => Promise<T>) {
      const size = jsonBytes(payload);
      if (
        closed ||
        size > provenancePolicy.recordBytes ||
        queue.size + queue.pending >= provenancePolicy.queueSubmissions ||
        bytes + size > provenancePolicy.queueBytes
      ) {
        counts.dropped++;
        throw new HouseholdError("capacity_exceeded");
      }
      bytes += size;
      try {
        const result = await queue.add(async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              return await save();
            } catch (error) {
              if (attempt === 1 || error instanceof HouseholdError) throw error;
            }
          }
        });
        counts.saved++;
        return result;
      } catch (error) {
        counts.failed++;
        throw error;
      } finally {
        bytes -= size;
      }
    },
    diagnostics: () => ({
      ...counts,
      pending: queue.size + queue.pending,
      bytes,
    }),
    async close() {
      closed = true;
      await queue.onIdle();
    },
  };
}
