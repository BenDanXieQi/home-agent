import { addAbortListener } from "node:events";
import PQueue from "p-queue";
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
  let revision = 0;
  // Preserve each device's acceptance order while allowing independent devices to save concurrently.
  const writers = new Map<string, { queue: PQueue; submissions: number }>();
  const pending = new Set<Promise<void>>();
  const listeners = new Set<
    (reports: Parameters<typeof repository.save>[1]) => void
  >();
  const diagnostics = {
    saved: 0,
    suppressed: 0,
    failed: 0,
    dropped: 0,
    peak_submissions: 0,
    peak_bytes: 0,
  };
  function submit(history: Parameters<typeof repository.save>[1]) {
    const first = history[0];
    if (!first || closed) return;
    const size = jsonBytes(history);
    if (
      pending.size >= historyWriteLimits.submissions ||
      bytes + size > historyWriteLimits.bytes
    ) {
      const dropped = diagnostics.dropped;
      diagnostics.dropped += history.length;
      if (
        dropped === 0 ||
        Math.floor(diagnostics.dropped / 100) > Math.floor(dropped / 100)
      )
        console.warn("Device history submission capacity exceeded");
      return;
    }
    const { identity, assertCurrent: assertAccessCurrent } = accessHousehold(
      household,
      first.scope_epoch,
    );
    const assertCurrent = () => {
      assertAccessCurrent();
      if (closed) throw new HouseholdError("stale_session");
    };
    // Admission belongs to the received batch, not to each device in an inventory.
    bytes += size;
    const tasks = [...Map.groupBy(history, (report) => report.device_id)].map(
      ([deviceId, reports]) => {
        const currentDeviceIds = () => {
          assertCurrent();
          const device =
            household.snapshot().projection.device[
              entityKey(identity.accountId, deviceId)
            ];
          return new Set(device && !device.archived ? [deviceId] : []);
        };
        let writer = writers.get(deviceId);
        if (!writer) {
          writer = { queue: new PQueue({ concurrency: 1 }), submissions: 0 };
          writers.set(deviceId, writer);
        }
        const currentWriter = writer;
        currentWriter.submissions++;
        return currentWriter.queue
          .add(() =>
            repository.save(
              { identity, assertCurrent, currentDeviceIds },
              reports,
            ),
          )
          .then(({ saved, suppressed }) => {
            diagnostics.saved += saved.length;
            diagnostics.suppressed += suppressed;
            diagnostics.dropped += reports.length - saved.length - suppressed;
            if (!saved.length) return;
            try {
              assertCurrent();
            } catch {
              // Saving succeeded; a later access revocation only suppresses publication.
              return;
            }
            revision++;
            for (const listener of listeners) {
              try {
                listener(saved);
              } catch {
                console.warn("Device history subscriber failed");
              }
            }
          })
          .catch((error: unknown) => {
            diagnostics.failed += reports.length;
            console.warn(
              "Device history submission discarded",
              error instanceof HouseholdError ? error.reason : "storage_failed",
            );
          })
          .finally(() => {
            if (--currentWriter.submissions === 0) writers.delete(deviceId);
          });
      },
    );
    const task = Promise.all(tasks).then(() => {
      pending.delete(task);
      bytes -= size;
    });
    pending.add(task);
    diagnostics.peak_submissions = Math.max(
      diagnostics.peak_submissions,
      pending.size,
    );
    diagnostics.peak_bytes = Math.max(diagnostics.peak_bytes, bytes);
  }
  const unsubscribe = household.subscribeFacts(({ history }) => {
    if (!history || closed) return;
    submit(history);
  });
  return {
    revision: () => revision,
    diagnostics: () => ({ ...diagnostics, submissions: pending.size, bytes }),
    subscribe(
      listener: (reports: Parameters<typeof repository.save>[1]) => void,
    ) {
      if (!closed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close(signal: AbortSignal) {
      closed = true;
      unsubscribe();
      listeners.clear();
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
