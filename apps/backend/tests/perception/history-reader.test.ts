import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowSummarySchema } from "@home-agent/api/contracts";
import { createWindowHistory } from "../../src/perception/history/service";
import { createWindowHistoryReader } from "../../src/perception/history/reader";
import { createWindowHistoryRepository } from "../../src/perception/history/repository";
import { createWindowStore } from "../../src/perception/window/store";
import { createWindowMedia } from "../../src/perception/media/window-media";
import { perceptionConfigSchema } from "../../src/perception/config";
import { windowLimits } from "../../src/perception/window/limits";
import { HouseholdError } from "../../src/household/errors";
import type { PerceptionSources } from "../../src/perception/sources";
import { createAgentMaterialReader } from "../../src/agent-context/material";
import { runningHousehold } from "../support/household-harness";
import { createDatabase } from "../../src/db";
import { DrizzleQueryError } from "drizzle-orm";
import { deferred, nextTurn } from "../support/async";

type Repository = ReturnType<typeof createWindowHistoryRepository>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function fixture() {
  const household = await runningHousehold();
  const directory = await mkdtemp(join(tmpdir(), "window-history-"));
  const run = {
    deviceId: "device-a",
    channel: 1 as const,
    scopeEpoch: household.runtime.epoch,
    runId: crypto.randomUUID(),
  };
  let allowed = true;
  let stopped = false;
  let unavailable = false;
  const sources = {
    list: () => [{ deviceId: run.deviceId, channel: run.channel }],
    eligibility: () =>
      allowed && household.runtime.ready
        ? {
            scopeEpoch: household.runtime.epoch,
            householdVersion: household.runtime.version(),
            identity: "test",
          }
        : null,
    subscribe: () => () => {},
    prepare: () => Promise.reject(new Error("Media is not requested")),
  } satisfies PerceptionSources;
  const repository = {
    save: mock<Repository["save"]>(() => Promise.resolve()),
    get: mock<Repository["get"]>(() => Promise.resolve(undefined)),
    list: mock<Repository["list"]>(() => Promise.resolve([])),
    history: mock<Repository["history"]>(() => Promise.resolve([])),
    prune: mock<Repository["prune"]>(() => Promise.resolve()),
  };
  const history = createWindowHistory({
    repository,
    household: household.runtime,
    sources,
  });
  const windows = createWindowStore({
    config: () => perceptionConfigSchema.parse({}),
    authorized: () => allowed,
  });
  const media = createWindowMedia(windows, "ffmpeg", directory);
  const reader = createWindowHistoryReader({
    windows,
    media,
    history,
    sources,
    unavailable: () => unavailable,
    stopped: () => stopped,
  });
  const startedAt =
    Math.floor(Date.now() / windowLimits.durationMs) * windowLimits.durationMs -
    windowLimits.durationMs;
  windows.reconcile(
    [{ source: run, scopeEpoch: run.scopeEpoch, identity: "test" }],
    startedAt,
  );
  windows.bindVideo(run);
  const generation = crypto.randomUUID();
  for (let sequence = 1; sequence <= 2; sequence++) {
    const receivedAt = startedAt + sequence * 1000;
    windows.video(
      {
        event: "window_frame",
        run,
        skipped: 0,
        frame: {
          sequence,
          receivedAt,
          mediaTime: {
            generation,
            pts: sequence * 90000,
            rtpTimestamp: sequence * 90000,
            timeBaseNumerator: 1,
            timeBaseDenominator: 90000,
            quality: "source_media",
          },
          width: 2,
          height: 2,
          retainedWidth: 2,
          retainedHeight: 2,
          rgb: new Uint8Array(12),
          gray: new Uint8Array(windowLimits.graySide ** 2).fill(
            sequence === 1 ? 0 : 255,
          ),
        },
      },
      receivedAt,
    );
  }
  const closedAt = startedAt + windowLimits.durationMs + windowLimits.graceMs;
  windows.tick(closedAt);
  const [summary] = windows.snapshot(closedAt, run).windows;
  const window = windowSummarySchema.parse(
    windows.describe(summary!.id, closedAt),
  );
  const item = {
    household,
    repository,
    history,
    reader,
    windows,
    window,
    run,
    revoke: () => {
      allowed = false;
    },
    stop: () => {
      stopped = true;
      unavailable = true;
    },
    computationFailed: () => {
      unavailable = true;
    },
    async close() {
      await history.close();
      await media.close();
      windows.close();
      await household.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
  cleanups.push(() => item.close());
  return item;
}

const interval = (value: Awaited<ReturnType<typeof fixture>>) => ({
  start: new Date(value.window.startedAt).toISOString(),
  end: new Date(value.window.endedAt + 1).toISOString(),
  limit: 10,
});

test("storage failure preserves live detail and list while marking incomplete history", async () => {
  const value = await fixture();
  value.repository.get.mockRejectedValue(new HouseholdError("home_storage"));
  value.repository.list.mockRejectedValue(new HouseholdError("home_storage"));
  value.repository.history.mockRejectedValue(
    new HouseholdError("home_storage"),
  );
  expect((await value.reader.readWindow(value.window.id))?.id).toBe(
    value.window.id,
  );
  const list = await value.reader.listWindows(value.run);
  expect(list.windows.map(({ id }) => id)).toEqual([value.window.id]);
  expect(list.history.error).toContain("读取失败");
  await expect(
    value.reader.readWindow(crypto.randomUUID()),
  ).rejects.toMatchObject({
    reason: "home_storage",
  });
  const results = value.reader.history(interval(value));
  await expect(results.next()).rejects.toMatchObject({
    reason: "home_storage",
  });
});

test("storage failure keeps authorized pending records after live cache eviction", async () => {
  const value = await fixture();
  value.history.record(value.window);
  value.windows.close();
  value.repository.get.mockRejectedValue(new HouseholdError("home_storage"));
  value.repository.list.mockRejectedValue(new HouseholdError("home_storage"));
  const detail = await value.reader.readWindow(value.window.id);
  expect(detail?.id).toBe(value.window.id);
  expect(detail?.inputState).toBe("expired");
  expect((await value.reader.listWindows(value.run)).windows).toHaveLength(1);
  value.revoke();
  await expect(value.reader.readWindow(value.window.id)).rejects.toMatchObject({
    reason: "home_storage",
  });
  expect((await value.reader.listWindows(value.run)).windows).toHaveLength(0);
});

test("revoked household access cannot turn a failed archive read into a live result", async () => {
  const value = await fixture();
  const entered = deferred();
  const release = deferred();
  value.repository.get.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    throw new HouseholdError("home_storage");
  });
  const request = value.reader.readWindow(value.window.id);
  const outcome = request.catch((error: unknown) => error);
  await entered.promise;
  await value.household.runtime.bindHome(
    value.household.runtime.epoch,
    "home-b",
  );
  release.resolve();
  expect(await outcome).toMatchObject({ reason: "stale_session" });
});

test("stopping perception suppresses an archive result that completed late", async () => {
  const value = await fixture();
  const entered = deferred();
  const release = deferred<ReturnType<typeof windowSummarySchema.parse>>();
  value.repository.get.mockImplementation(() => {
    entered.resolve();
    return release.promise;
  });
  const request = value.reader.readWindow(value.window.id);
  const outcome = request.catch((error: unknown) => error);
  await entered.promise;
  value.stop();
  release.resolve(value.window);
  expect(await outcome).toMatchObject({ reason: "stale_session" });
});

for (const cancellation of ["request", "shutdown", "timeout"] as const) {
  test(`Agent material ${cancellation} stops waiting and rejects late window results`, async () => {
    const value = await fixture();
    const entered = deferred();
    const release = deferred<ReturnType<typeof windowSummarySchema.parse>>();
    let lateCheckRejected = false;
    value.repository.get.mockImplementation(
      async (_identity, assertCurrent) => {
        entered.resolve();
        const result = await release.promise;
        try {
          assertCurrent();
        } catch (error) {
          lateCheckRejected = true;
          throw error;
        }
        return result;
      },
    );
    const shutdown = new AbortController();
    const request = new AbortController();
    const readMaterial = createAgentMaterialReader(
      value.household.runtime,
      undefined,
      value.reader,
      shutdown.signal,
      cancellation === "timeout" ? 25 : 1000,
    );
    const household =
      value.household.runtime.snapshot().projection.household.household;
    const result = readMaterial(
      {
        kind: "perception_window",
        scope: {
          scope_epoch: value.household.runtime.epoch,
          account_id: household.account_id!,
          home_id: household.home_id!,
        },
        id: value.window.id,
      },
      request.signal,
    );
    const outcome = result.catch((error: unknown) => error);
    await entered.promise;
    if (cancellation === "request") request.abort();
    if (cancellation === "shutdown") shutdown.abort();
    expect(await outcome).toMatchObject({
      code: cancellation === "timeout" ? "agent_timeout" : "request_cancelled",
    });
    expect(lateCheckRejected).toBe(false);
    release.resolve(value.window);
    await nextTurn();
    expect(lateCheckRejected).toBe(true);
    expect(value.history.status().error).toBeNull();
  });
}

test("history shutdown ends pending reads before database work finishes", async () => {
  const value = await fixture();
  const entered = deferred();
  const release = deferred<ReturnType<typeof windowSummarySchema.parse>>();
  value.repository.get.mockImplementation(() => {
    entered.resolve();
    return release.promise;
  });
  const request = value.history.get(value.window.id);
  const outcome = request.catch((error: unknown) => error);
  await entered.promise;
  await value.history.close();
  expect(await outcome).toMatchObject({ reason: "stale_session" });
  release.resolve(value.window);
  await nextTurn();
});

test("invalid persisted data is not hidden by cached detail or list", async () => {
  const value = await fixture();
  value.repository.get.mockImplementation(() =>
    Promise.resolve(windowSummarySchema.parse({})),
  );
  value.repository.list.mockImplementation(() =>
    Promise.resolve([windowSummarySchema.parse({})]),
  );
  await expect(value.reader.readWindow(value.window.id)).rejects.toMatchObject({
    name: "ZodError",
  });
  await expect(value.reader.listWindows(value.run)).rejects.toMatchObject({
    name: "ZodError",
  });
  expect(value.history.status().error).toBeNull();
});

test("discarding revoked pending writes remains visible after a successful flush", async () => {
  const value = await fixture();
  value.history.record(value.window);
  await value.household.runtime.bindHome(
    value.household.runtime.epoch,
    "home-b",
  );
  await value.history.close();
  expect(value.repository.save).not.toHaveBeenCalled();
  expect(value.history.status().error).toContain("访问范围已变化");
  await value.history.close();
  expect(value.history.status().error).toContain("已丢弃");
});

test("computation failure does not revoke a still authorized cached window", async () => {
  const value = await fixture();
  value.computationFailed();
  expect((await value.reader.readWindow(value.window.id))?.id).toBe(
    value.window.id,
  );
  expect((await value.reader.listWindows(value.run)).windows).toHaveLength(1);
  await expect(value.reader.history(interval(value)).next()).rejects.toThrow(
    "Perception history unavailable",
  );
});

test("repository distinguishes database connection failures from invalid persisted data", async () => {
  const database = createDatabase("postgres://test:test@127.0.0.1:1/test");
  const transaction = spyOn(database.db, "transaction");
  const repository = createWindowHistoryRepository(database.db);
  const identity = { accountId: "account", homeId: "home" };
  const id = crypto.randomUUID();
  try {
    transaction.mockRejectedValue(
      new DrizzleQueryError(
        "select",
        [],
        Object.assign(new Error("connection refused"), {
          code: "ECONNREFUSED",
        }),
      ),
    );
    await expect(repository.get(identity, () => {}, id)).rejects.toMatchObject({
      reason: "home_storage",
    });
    const validation = windowSummarySchema.safeParse({});
    if (validation.success) throw new Error("Expected invalid window data");
    const invalidData = new DrizzleQueryError("select", [], validation.error);
    transaction.mockRejectedValue(invalidData);
    await expect(repository.get(identity, () => {}, id)).rejects.toBe(
      invalidData,
    );
    transaction.mockRejectedValue(new HouseholdError("stale_session"));
    await expect(repository.get(identity, () => {}, id)).rejects.toMatchObject({
      reason: "stale_session",
    });
  } finally {
    transaction.mockRestore();
    await database.close();
  }
});

test("shutdown drains a newer revision accepted while the same window is being saved", async () => {
  const value = await fixture();
  const entered = deferred();
  const release = deferred();
  const revisions: number[] = [];
  value.repository.save.mockImplementation(
    async (_identity, assertCurrent, summary) => {
      revisions.push(summary.revision);
      entered.resolve();
      await release.promise;
      assertCurrent();
    },
  );
  value.history.record(value.window);
  await entered.promise;
  value.history.record({
    ...value.window,
    revision: value.window.revision + 1,
  });
  const closing = value.history.close();
  release.resolve();
  await closing;
  expect(revisions).toEqual([value.window.revision, value.window.revision + 1]);
  expect(value.history.status().error).toBeNull();
});

test("a full pending queue still accepts the latest revision for an existing window", async () => {
  const value = await fixture();
  let revision: number | undefined;
  value.repository.save.mockImplementation(
    (_identity, _assertCurrent, summary) => {
      if (summary.id === value.window.id) revision = summary.revision;
      return Promise.resolve();
    },
  );
  value.history.record(value.window);
  for (let count = 1; count < 4096; count++)
    value.history.record({ ...value.window, id: crypto.randomUUID() });
  value.history.record({
    ...value.window,
    revision: value.window.revision + 1,
  });
  await value.history.close();
  expect(value.repository.save).toHaveBeenCalledTimes(4096);
  expect(revision).toBe(value.window.revision + 1);
  expect(value.history.status().error).toBeNull();
});
