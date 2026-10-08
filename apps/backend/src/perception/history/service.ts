import pTimeout from "p-timeout";
import { HouseholdError } from "../../household/errors";
import {
  compareWindowPosition,
  matchesWindowList,
  createWindowHistoryMatcher,
} from "./query";
import {
  windowHistoryRetentionMs,
  type windowSummarySchema,
  type windowListQuerySchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import type { createWindowHistoryRepository } from "./repository";
import { accessHousehold } from "../../household/access";
import type { HouseholdRuntime } from "../../household/runtime";
import type { PerceptionSources } from "../sources";

function merge(
  saved: z.infer<typeof windowSummarySchema>[],
  queued: z.infer<typeof windowSummarySchema>[],
) {
  const records = new Map(saved.map((summary) => [summary.id, summary]));
  for (const summary of queued) {
    if (summary.revision >= (records.get(summary.id)?.revision ?? -1))
      records.set(summary.id, summary);
  }
  return [...records.values()];
}

/** Owns durable observations; media leases and their expiry remain in the live store. */
export function createWindowHistory(options: {
  repository: ReturnType<typeof createWindowHistoryRepository>;
  household: HouseholdRuntime;
  sources: PerceptionSources;
}) {
  const { repository, household, sources } = options;
  const pending = new Map<
    string,
    {
      summary: z.infer<typeof windowSummarySchema>;
      access: ReturnType<typeof accessHousehold>;
      bytes: number;
    }
  >();
  let pendingBytes = 0;
  let error: string | null = null;
  let dropped = false;
  let accessDropped = false;
  let readError: string | null = null;
  const shutdown = new AbortController();
  let saving: Promise<void> | undefined;
  let stopped = false;
  let pruning: Promise<void> | undefined;
  let pruneError: string | null = null;
  function flush() {
    if (saving) return saving;
    saving = (async () => {
      while (pending.size) {
        const [id, item] = pending.entries().next().value!;
        try {
          item.access.assertCurrent();
        } catch {
          accessDropped = true;
          pending.delete(id);
          pendingBytes -= item.bytes;
          continue;
        }
        await repository.save(
          item.access.identity,
          item.access.assertCurrent,
          item.summary,
        );
        if (pending.get(id) === item) {
          pending.delete(id);
          pendingBytes -= item.bytes;
        }
      }
      error = null;
    })()
      .catch((cause: unknown) => {
        error = "历史记录保存失败，正在重试";
        console.error("Perception history storage failed", cause);
      })
      .finally(() => {
        saving = undefined;
      });
    return saving;
  }
  const timer = setInterval(() => {
    // flush records failures and retains pending writes for the next attempt.
    // oxlint-disable-next-line typescript/no-floating-promises
    flush();
  }, 1000);
  timer.unref();
  function prune() {
    if (pruning) return;
    pruning = repository
      .prune()
      .then(() => {
        pruneError = null;
      })
      .catch((cause: unknown) => {
        pruneError = "到期历史记录清理失败，正在重试";
        console.error("Perception history cleanup failed", cause);
      })
      .finally(() => {
        pruning = undefined;
      });
  }
  const pruneTimer = setInterval(prune, 60_000);
  pruneTimer.unref();
  prune();
  function access() {
    shutdown.signal.throwIfAborted();
    return accessHousehold(household, household.epoch);
  }
  async function read<T>(
    grant: ReturnType<typeof access>,
    signal: AbortSignal | undefined,
    run: (assertCurrent: () => void) => Promise<T>,
  ) {
    const request = AbortSignal.any([
      shutdown.signal,
      ...(signal ? [signal] : []),
    ]);
    const assertCurrent = () => {
      request.throwIfAborted();
      grant.assertCurrent();
    };
    assertCurrent();
    try {
      const result = await pTimeout(run(assertCurrent), {
        milliseconds: Number.POSITIVE_INFINITY,
        signal: request,
      });
      assertCurrent();
      readError = null;
      return result;
    } catch (cause) {
      assertCurrent();
      if (cause instanceof HouseholdError && cause.reason === "home_storage")
        readError = "历史记录读取失败，当前仅显示内存中的记录";
      throw cause;
    }
  }
  function authorized(summary: z.infer<typeof windowSummarySchema>) {
    return !!sources.eligibility(summary.run);
  }
  function queued(grant: ReturnType<typeof access>) {
    grant.assertCurrent();
    return [...pending.values()]
      .filter(
        (item) =>
          item.summary.run.scopeEpoch === household.epoch &&
          item.access.identity.accountId === grant.identity.accountId &&
          item.access.identity.homeId === grant.identity.homeId &&
          item.summary.summaryUntil > Date.now() &&
          authorized(item.summary),
      )
      .map((item) => item.summary);
  }
  return {
    record(value: z.infer<typeof windowSummarySchema>) {
      if (stopped) return;
      try {
        const grant = accessHousehold(household, value.run.scopeEpoch);
        if (!authorized(value)) return;
        const summary = structuredClone(value);
        summary.summaryUntil = summary.closedAt + windowHistoryRetentionMs;
        summary.inputState = "expired";
        const bytes = Buffer.byteLength(JSON.stringify(summary));
        const previous = pending.get(summary.id);
        if (previous && previous.summary.revision > summary.revision) return;
        if (
          (!previous && pending.size >= 4096) ||
          pendingBytes - (previous?.bytes ?? 0) + bytes > 64 * 1024 * 1024
        ) {
          dropped = true;
          console.error("Perception history pending capacity exceeded");
          return;
        }
        pendingBytes += bytes - (previous?.bytes ?? 0);
        pending.set(summary.id, { summary, access: grant, bytes });
      } catch (cause) {
        console.error("Perception history admission failed", cause);
      }
    },
    async get(id: string, signal?: AbortSignal) {
      const grant = access();
      let failure: HouseholdError | undefined;
      const saved = await read(grant, signal, (assertCurrent) =>
        repository.get(grant.identity, assertCurrent, id),
      ).catch((cause: unknown) => {
        if (
          !(cause instanceof HouseholdError && cause.reason === "home_storage")
        )
          throw cause;
        failure = cause;
        return undefined;
      });
      const latest = queued(grant).find((summary) => summary.id === id);
      if (failure && !latest) throw failure;
      const summary =
        latest && latest.revision >= (saved?.revision ?? -1) ? latest : saved;
      return summary && summary.summaryUntil > Date.now() && authorized(summary)
        ? summary
        : undefined;
    },
    async list(
      query: z.infer<typeof windowListQuerySchema>,
      signal?: AbortSignal,
    ) {
      const grant = accessHousehold(household, query.scopeEpoch);
      if (!sources.eligibility(query)) return [];
      const records = await read(grant, signal, (assertCurrent) =>
        repository.list(grant.identity, assertCurrent, query),
      ).catch((cause: unknown) => {
        if (cause instanceof HouseholdError && cause.reason === "home_storage")
          return [];
        throw cause;
      });
      const pendingRecords = queued(grant).filter((entry) =>
        matchesWindowList(entry, query),
      );
      return sources.eligibility(query)
        ? merge(records, pendingRecords)
            .toSorted((a, b) => compareWindowPosition(b, a))
            .slice(0, 51)
        : [];
    },
    async history(
      input: Parameters<typeof repository.history>[2],
      after?: Parameters<typeof repository.history>[3],
      signal?: AbortSignal,
    ) {
      const grant = access();
      const selected = sources
        .list()
        .filter(
          (source) =>
            !input.sources ||
            input.sources.some(
              (filter) =>
                filter.device_id === source.deviceId &&
                (filter.channel === undefined ||
                  filter.channel === source.channel),
            ),
        );
      if (!selected.length) return [];
      const records = await read(grant, signal, (assertCurrent) =>
        repository.history(
          grant.identity,
          assertCurrent,
          {
            ...input,
            sources: selected.map((source) => ({
              device_id: source.deviceId,
              channel: source.channel,
            })),
          },
          after,
        ),
      );
      const matcher = createWindowHistoryMatcher(input);
      const pendingRecords = queued(grant).filter(
        (entry) =>
          (!after || compareWindowPosition(entry, after) > 0) &&
          matcher.matches(entry),
      );
      return merge(records, pendingRecords)
        .toSorted(compareWindowPosition)
        .slice(0, input.limit + 1);
    },
    status() {
      return {
        enabled: true,
        error:
          error ??
          pruneError ??
          readError ??
          (accessDropped ? "访问范围已变化，部分待保存历史记录已丢弃" : null) ??
          (dropped ? "历史记录待保存队列曾满，部分记录未保存" : null),
      };
    },
    async close() {
      stopped = true;
      shutdown.abort(new HouseholdError("stale_session"));
      clearInterval(timer);
      clearInterval(pruneTimer);
      await flush();
      await pruning;
      if (pending.size)
        throw new Error("Perception history has unsaved records");
    },
  };
}
