import { addAbortListener } from "node:events";
import {
  deviceHistoryTimeSchema,
  deviceHistoryPolicy,
  type deviceHistoryResponseSchema,
} from "@home-agent/api/device-history";
import { jsonBytes } from "../config";
import type { createDeviceHistoryReader } from "./read";
import type { createDeviceHistoryService } from "./service";

/** The first displayed record to leave the rolling retention interval. */
export function historyPageExpiresAt(
  page: ReturnType<typeof deviceHistoryResponseSchema.parse>,
) {
  return page.records.reduce(
    (earliest, record) =>
      Math.min(
        earliest,
        Date.parse(record.received_at) +
          deviceHistoryPolicy.retentionDays * 86_400_000 +
          1,
      ),
    Infinity,
  );
}

/** Active identical queries share their committed revision and in-flight read. */
export function createDeviceHistoryLiveReader(
  read: ReturnType<typeof createDeviceHistoryReader>,
  history:
    | Pick<ReturnType<typeof createDeviceHistoryService>, "revision">
    | undefined,
) {
  const entries = new Map<
    string,
    {
      controller: AbortController;
      references: number;
      revision: number;
      expiresAt: number;
      page: ReturnType<typeof read> | undefined;
    }
  >();
  return {
    acquire(scope: string, input: Parameters<typeof read>[0]) {
      const { end: _end, cursor: _cursor, ...conditions } = input;
      const key = JSON.stringify([scope, conditions]);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          controller: new AbortController(),
          references: 0,
          revision: -1,
          expiresAt: Infinity,
          page: undefined,
        };
        entries.set(key, entry);
      }
      const current = entry;
      current.references++;
      let released = false;
      return {
        async read(signal: AbortSignal) {
          signal.throwIfAborted();
          const revision = history?.revision() ?? 0;
          if (
            !current.page ||
            current.revision !== revision ||
            Date.now() >= current.expiresAt
          ) {
            current.revision = revision;
            current.expiresAt = Infinity;
            const page = read(
              {
                ...input,
                cursor: undefined,
                end: deviceHistoryTimeSchema.parse(new Date().toISOString()),
              },
              current.controller.signal,
              jsonBytes,
            ).then((result) => {
              if (current.page === page)
                current.expiresAt = historyPageExpiresAt(result);
              return result;
            });
            current.page = page;
            page.catch(() => {
              if (current.page === page) current.page = undefined;
            });
          }
          const aborted = Promise.withResolvers<never>();
          const listener = addAbortListener(signal, () =>
            aborted.reject(signal.reason),
          );
          try {
            const page = await Promise.race([current.page, aborted.promise]);
            signal.throwIfAborted();
            return page;
          } finally {
            listener[Symbol.dispose]();
          }
        },
        release() {
          if (released) return;
          released = true;
          if (--current.references === 0) {
            entries.delete(key);
            current.controller.abort();
          }
        },
      };
    },
  };
}
