import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import postgres from "postgres";
import { asc, sql } from "drizzle-orm";
import {
  windowHistoryRetentionMs,
  windowSummarySchema,
} from "@home-agent/api/contracts";
import { createDatabase } from "../../src/db";
import {
  mijiaHomeSelections,
  perceptionMarkers,
  perceptionWindows,
} from "../../src/db/schema";
import { lockTransaction } from "../../src/db/transaction-outcome";
import { clearHouseholdData } from "../../src/household/data-lifecycle";
import { HouseholdError } from "../../src/household/errors";
import { createWindowHistoryRepository } from "../../src/perception/history/repository";
import { deferred } from "../support/async";

// oxlint-disable-next-line turbo/no-undeclared-env-vars -- This opt-in database fixture runs directly with bun test.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const identity = { accountId: "test-account", homeId: "test-home" };
const source = {
  deviceId: "test-camera",
  channel: 1 as const,
  scopeEpoch: crypto.randomUUID(),
};
const assertCurrent = () => {};

function observation(startedAt: number, endedAt: number) {
  return windowSummarySchema.parse({
    id: crypto.randomUUID(),
    revision: 0,
    run: { ...source, runId: crypto.randomUUID() },
    videoRun: null,
    generation: null,
    processingVersion: "media-window-1",
    startedAt,
    endedAt,
    closedAt: endedAt,
    readableUntil: endedAt,
    summaryUntil: endedAt + windowHistoryRetentionMs,
    timeBasis: "host_receive",
    synchronizationAccuracyMs: null,
    incomplete: false,
    gaps: [],
    frames: [],
    speech: {
      enabled: false,
      acceptingUntil: endedAt,
      segments: [],
      truncated: false,
    },
    audio: {
      status: "no_track",
      run: null,
      generation: null,
      startedAt: null,
      endedAt: null,
      samples: 0,
      energyBlocks: 0,
      activeEnergyBlocks: 0,
      peakRms: 0,
      speechBlocks: 0,
      vad: "unavailable",
    },
    gate: {
      candidate: "video",
      visual: "changed",
      changedRatio: 0.1,
      comparisons: [],
      holdUntil: null,
      audioPassed: false,
    },
    crop: null,
    inputState: "expired",
  });
}

describe.skipIf(!testDatabaseUrl)(
  "stored continuous perception markers",
  () => {
    let admin: ReturnType<typeof postgres>;
    let database: ReturnType<typeof createDatabase>;
    let repository: ReturnType<typeof createWindowHistoryRepository>;
    let databaseName: string | undefined;
    let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;

    beforeAll(async () => {
      if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
      admin = postgres(testDatabaseUrl, { max: 1 });
      const name = `home_agent_marker_test_${crypto.randomUUID().replaceAll("-", "")}`;
      await admin.unsafe(`create database "${name}"`);
      databaseName = name;

      const url = new URL(testDatabaseUrl);
      url.pathname = `/${databaseName}`;
      database = createDatabase(url.toString());
      const baseline = await Bun.file(
        new URL("../../drizzle/0000_initialize_database.sql", import.meta.url),
      ).text();
      for (const statement of baseline.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.db.$client.unsafe(statement);
      }
      repository = createWindowHistoryRepository(database.db);
    }, 30_000);

    afterAll(async () => {
      try {
        await database?.close();
        if (databaseName)
          await admin.unsafe(`drop database "${databaseName}" with (force)`);
      } finally {
        await admin?.end({ timeout: 5 });
      }
    });

    beforeEach(async () => {
      await database.db.delete(perceptionMarkers);
      await database.db.delete(perceptionWindows);
      await database.db.delete(mijiaHomeSelections);
      await database.db
        .insert(mijiaHomeSelections)
        .values({ accountKey: identity.accountId, homeId: identity.homeId });
    });

    afterEach(() => {
      clock?.mockRestore();
      clock = undefined;
    });

    const save = (value: ReturnType<typeof observation>) =>
      repository.save(identity, assertCurrent, value);
    const markers = () =>
      database.db
        .select()
        .from(perceptionMarkers)
        .orderBy(
          asc(perceptionMarkers.deviceId),
          asc(perceptionMarkers.channel),
          asc(perceptionMarkers.startedAt),
        );

    async function holdSource() {
      const entered = deferred();
      const released = deferred();
      const transaction = database.db.transaction(async (tx) => {
        await lockTransaction(
          tx,
          JSON.stringify([
            "perception_markers",
            source.deviceId,
            source.channel,
          ]),
          "exclusive",
        );
        entered.resolve();
        await released.promise;
      });
      await entered.promise;
      return async () => {
        released.resolve();
        await transaction;
      };
    }

    async function waitForBlockedTransactions(count: number) {
      const deadline = performance.now() + 2_000;
      while (performance.now() < deadline) {
        const [row] = await database.db.execute<{ waiting: number }>(
          sql`select count(*)::integer as waiting from pg_stat_activity where datname = current_database() and wait_event = 'advisory'`,
        );
        if (row && row.waiting >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(
        `Expected ${count} transactions waiting for advisory locks`,
      );
    }

    test("adjacent and overlapping observations retain one full interval", async () => {
      const start = Date.now() - 20_000;
      await save(observation(start, start + 4_000));
      await save(observation(start + 4_000, start + 8_000));
      await save(observation(start + 6_000, start + 12_000));

      expect(await markers()).toMatchObject([
        { startedAt: start, endedAt: start + 12_000 },
      ]);
      expect(await database.db.$count(perceptionWindows)).toBe(3);
    });

    test("a real gap stays separate and sources never merge", async () => {
      const start = Date.now() - 20_000;
      await save(observation(start, start + 4_000));
      await save(observation(start + 4_001, start + 8_000));
      const otherDevice = observation(start, start + 8_000);
      otherDevice.run.deviceId = "test-camera-b";
      await save(otherDevice);
      const otherChannel = observation(start, start + 8_000);
      otherChannel.run.channel = 2;
      await save(otherChannel);

      expect(await markers()).toMatchObject([
        {
          deviceId: source.deviceId,
          channel: 1,
          startedAt: start,
          endedAt: start + 4_000,
        },
        { startedAt: start + 4_001, endedAt: start + 8_000 },
        { channel: 2, startedAt: start, endedAt: start + 8_000 },
        { deviceId: "test-camera-b", startedAt: start, endedAt: start + 8_000 },
      ]);
    });

    test("an out of order bridge joins both intervals and keeps the earliest marker", async () => {
      const start = Date.now() - 20_000;
      await save(observation(start + 8_000, start + 12_000));
      await save(observation(start, start + 4_000));
      const earliest = (await markers())[0]!;
      await save(observation(start + 4_000, start + 8_000));

      expect(await markers()).toEqual([
        { ...earliest, startedAt: start, endedAt: start + 12_000 },
      ]);
    });

    test("duplicate and older revisions do not add markers or replace newer facts", async () => {
      const start = Date.now() - 20_000;
      const value = observation(start, start + 4_000);
      await save(value);
      const before = await markers();
      await save({ ...value, revision: 2 });
      await save({ ...value, revision: 1 });
      await save(value);

      expect(await markers()).toEqual(before);
      expect(
        await repository.get(identity, assertCurrent, value.id),
      ).toMatchObject({
        id: value.id,
        revision: 2,
      });
    });

    test("concurrent writers serialize before joining adjacent intervals", async () => {
      const start = Date.now() - 20_000;
      const release = await holdSource();
      const saving = [0, 8_000, 4_000].map((offset) =>
        save(observation(start + offset, start + offset + 4_000)),
      );
      try {
        await waitForBlockedTransactions(3);
      } finally {
        await release();
        await Promise.all(saving);
      }

      expect(await markers()).toMatchObject([
        { startedAt: start, endedAt: start + 12_000 },
      ]);
    });

    test("crossing midnight does not split a continuous interval", async () => {
      const today = new Date();
      const midnight = Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate(),
      );
      await save(observation(midnight - 4_000, midnight));
      await save(observation(midnight, midnight + 4_000));

      expect(await markers()).toMatchObject([
        { startedAt: midnight - 4_000, endedAt: midnight + 4_000 },
      ]);
    });

    test("pagination returns every marker once after more than fifty gaps", async () => {
      const start = Date.now() - 1_000_000;
      for (let index = 0; index < 62; index++)
        await save(
          observation(start + index * 8_000, start + index * 8_000 + 4_000),
        );

      const first = await repository.list(identity, assertCurrent, source);
      expect(first).toHaveLength(51);
      const page = first.slice(0, 50);
      const last = page.at(-1)!;
      const second = await repository.list(identity, assertCurrent, {
        ...source,
        before: last.startedAt,
        beforeId: last.id,
      });

      expect(second).toHaveLength(12);
      const all = [...page, ...second];
      expect(new Set(all.map((marker) => marker.id)).size).toBe(62);
      expect(all.map((marker) => marker.startedAt)).toEqual(
        Array.from({ length: 62 }, (_, index) => start + (61 - index) * 8_000),
      );
    });

    test("range queries return the complete overlapping marker without raw evidence", async () => {
      const start = Date.now() - 20_000;
      await save(observation(start, start + 12_000));
      await database.db.delete(perceptionWindows);

      expect(
        await repository.list(identity, assertCurrent, {
          ...source,
          start: start + 4_000,
          end: start + 8_000,
        }),
      ).toMatchObject([{ startedAt: start, endedAt: start + 12_000 }]);
      await repository.prune();
      expect(await database.db.$count(perceptionMarkers)).toBe(1);
    });

    test("retention clips old starts and removes expired intervals", async () => {
      const now = Date.now();
      clock = spyOn(Date, "now").mockReturnValue(now);
      const cutoff = now - windowHistoryRetentionMs;
      await save(observation(cutoff - 8_000, cutoff - 4_000));
      await save(observation(cutoff - 4_000, cutoff + 8_000));
      expect(await markers()).toMatchObject([
        { startedAt: cutoff, endedAt: cutoff + 8_000 },
      ]);

      clock.mockReturnValue(now + 4_000);
      await repository.prune();
      expect(await markers()).toMatchObject([
        { startedAt: cutoff + 4_000, endedAt: cutoff + 8_000 },
      ]);

      clock.mockReturnValue(now + 8_000);
      await repository.prune();
      expect(await markers()).toEqual([]);
    });

    test("pruning and concurrent extension preserve both the cutoff and new end", async () => {
      const now = Date.now();
      clock = spyOn(Date, "now").mockReturnValue(now);
      const cutoff = now - windowHistoryRetentionMs;
      await save(observation(cutoff - 4_000, cutoff + 4_000));
      clock.mockReturnValue(now + 2_000);

      await Promise.all([
        repository.prune(),
        save(observation(cutoff + 4_000, cutoff + 12_000)),
      ]);

      expect(await markers()).toMatchObject([
        { startedAt: cutoff + 2_000, endedAt: cutoff + 12_000 },
      ]);
    });

    test("household replacement clears markers after an in flight save and rejects stale writes", async () => {
      const start = Date.now() - 20_000;
      const release = await holdSource();
      const saving = save(observation(start, start + 4_000));
      let replacing: Promise<void> | undefined;
      try {
        await waitForBlockedTransactions(1);
        replacing = database.db.transaction(async (tx) => {
          await lockTransaction(tx, "household_binding", "exclusive");
          await clearHouseholdData(tx);
          await tx.delete(mijiaHomeSelections);
          await tx.insert(mijiaHomeSelections).values({
            accountKey: identity.accountId,
            homeId: "replacement-home",
          });
        });
        await waitForBlockedTransactions(2);
      } finally {
        await release();
        await saving;
        await replacing;
      }

      expect(await markers()).toEqual([]);
      expect(await database.db.$count(perceptionWindows)).toBe(0);
      await expect(
        save(observation(start + 4_000, start + 8_000)),
      ).rejects.toThrow(HouseholdError);
      expect(await markers()).toEqual([]);
    });
  },
);
