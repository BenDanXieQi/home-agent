import { addAbortListener } from "node:events";
import { entityKey } from "@home-agent/api/household";
import type { HouseholdRuntime } from "../runtime";
import { accessHousehold } from "../access";
import { HouseholdError } from "../errors";
import { jsonBytes } from "../config";
import type { createDeviceHistoryRepository } from "./repository";

export const historyWriteLimits = {
  submissions: 256,
  bytes: 4 * 1024 * 1024,
} as const;
export function createDeviceHistoryService(
  household: HouseholdRuntime,
  repository: ReturnType<typeof createDeviceHistoryRepository>,
) {
  let closed = false;
  let bytes = 0;
  const pending = new Set<Promise<void>>();
  const diagnostics = {
    saved: 0,
    failed: 0,
    dropped: 0,
    peak_submissions: 0,
    peak_bytes: 0,
  };
  const unsubscribe = household.subscribeFacts(({ history }) => {
    if (!history || closed) return;
    const size = jsonBytes(history);
    if (
      pending.size >= historyWriteLimits.submissions ||
      bytes + size > historyWriteLimits.bytes
    ) {
      diagnostics.dropped++;
      if (diagnostics.dropped === 1 || diagnostics.dropped % 100 === 0)
        console.warn("Device history submission capacity exceeded");
      return;
    }
    const { identity, assertCurrent: assertAccessCurrent } = accessHousehold(
      household,
      history.scope_epoch,
    );
    const assertCurrent = () => {
      assertAccessCurrent();
      const device =
        household.snapshot().projection.device[
          entityKey(identity.accountId, history.device_id)
        ];
      if (closed || !device || device.archived)
        throw new HouseholdError("stale_session");
    };
    bytes += size;
    const task = repository
      .save({ identity, assertCurrent }, history)
      .then((saved) => {
        if (saved) diagnostics.saved++;
        else diagnostics.dropped++;
      })
      .catch((error: unknown) => {
        diagnostics.failed++;
        console.warn(
          "Device history report discarded",
          error instanceof HouseholdError ? error.reason : "storage_failed",
        );
      })
      .finally(() => {
        pending.delete(task);
        bytes -= size;
      });
    pending.add(task);
    diagnostics.peak_submissions = Math.max(
      diagnostics.peak_submissions,
      pending.size,
    );
    diagnostics.peak_bytes = Math.max(diagnostics.peak_bytes, bytes);
  });
  return {
    diagnostics: () => ({ ...diagnostics, submissions: pending.size, bytes }),
    async close(signal: AbortSignal) {
      closed = true;
      unsubscribe();
      const aborted = Promise.withResolvers<void>();
      const listener = addAbortListener(signal, () => {
        aborted.resolve();
      });
      try {
        await Promise.race([Promise.allSettled(pending), aborted.promise]);
      } finally {
        listener[Symbol.dispose]();
      }
    },
  };
}
