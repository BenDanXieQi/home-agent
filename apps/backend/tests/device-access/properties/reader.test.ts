import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PropertyReader } from "../../../src/mijia/properties/reader";
import { MiCloud, MiCloudError } from "../../../src/mijia/protocols/micloud";
import { deferred, nextTurn } from "../../support/async";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) restore();
});

function readerHarness(
  implementation: MiCloud["getProperties"],
  reader = new PropertyReader(),
) {
  const client = new MiCloud();
  const request = spyOn(client, "getProperties").mockImplementation(
    implementation,
  );
  restores.push(() => {
    request.mockRestore();
    client.dispose();
  });
  const context = {
    client,
    source_id: "source-a",
    collection_generation: "generation-a",
    assertCurrent: () => {},
  };
  const read = (
    properties = addresses(1),
    controller = new AbortController(),
  ) => reader.read(properties, context, controller.signal);
  return { reader, request, context, read };
}

function addresses(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    did: "device-a",
    siid: 2,
    piid: index + 1,
  }));
}

describe("property reading contract", () => {
  test("classifies individual codes and explicit values without losing other rows", async () => {
    const requested = addresses(14);
    const rows = [
      { ...requested[0], code: 0, value: false },
      { ...requested[1], code: -702000000, value: 0 },
      { ...requested[2], code: -702010000, value: "" },
      { ...requested[3], code: 4, value: null },
      { ...requested[4], code: -1, value: 42 },
      { ...requested[5], code: -0.5, value: 1 },
      { ...requested[6], code: "-1", value: 2 },
      { ...requested[7], value: 3 },
      { ...requested[8], code: 0 },
      { ...requested[9], value: { reading: 1 } },
      { ...requested[10], value: [1] },
      { ...requested[11], value: Number.NaN },
      { ...requested[12], value: Number.POSITIVE_INFINITY },
    ];
    const { read } = readerHarness(() => Promise.resolve(rows));
    const results = await read(requested);
    expect(results.map(({ status }) => status)).toEqual([
      "success",
      "success",
      "success",
      "success",
      "failure",
      "success",
      "success",
      "success",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(results.slice(0, 4)).toMatchObject([
      { value: false },
      { value: 0 },
      { value: "" },
      { value: null },
    ]);
    expect(results[4]).toMatchObject({ code: -1, status: "failure" });
    expect(results[8]).toMatchObject({ reason: "value_missing" });
    expect(results.slice(9, 13)).toMatchObject(
      Array.from({ length: 4 }, () => ({ reason: "invalid_value" })),
    );
    expect(results[13]).toMatchObject({ reason: "response_missing" });
    expect(results[8]).not.toHaveProperty("value");
  });

  test("aligns exact addresses in request order; duplicates cannot erase a success", async () => {
    const requested = addresses(3);
    const { read } = readerHarness(() =>
      Promise.resolve([
        { ...requested[1], code: -1 },
        { ...requested[1], value: 20 },
        { ...requested[0], value: 10 },
        { ...requested[0], code: -1 },
        { ...requested[0], value: [] },
        { ...requested[2], did: "other-device", value: 30 },
        { ...requested[2], siid: 3, value: 30 },
        { ...requested[2], piid: "3", value: 30 },
      ]),
    );
    expect(await read(requested)).toMatchObject([
      { ...requested[0], status: "success", value: 10 },
      { ...requested[1], status: "success", value: 20 },
      { ...requested[2], status: "unavailable", reason: "response_missing" },
    ]);
  });

  test("keeps cloud-cache timing and provenance distinct from device event time", async () => {
    const started = "2026-01-02T03:04:05.000Z";
    const { read } = readerHarness((batch, _signal, onStarted) => {
      onStarted?.(started);
      return Promise.resolve(
        batch.map((property) => ({ ...property, value: 1 })),
      );
    });
    expect(await read()).toMatchObject([
      {
        source_id: "source-a",
        collection_generation: "generation-a",
        delivery_kind: "baseline",
        read_semantics: "cloud_cache",
        observed_at: null,
        read_started_at: started,
        received_at: expect.any(String),
        contract_id: expect.any(String),
        contract_version: expect.any(Number),
      },
    ]);
  });

  test("shares a serial 150-item budget across overlapping invocations", async () => {
    const firstStarted = deferred();
    const release = deferred<unknown[]>();
    let active = 0;
    let maximumActive = 0;
    let count = 0;
    const sizes: number[] = [];
    const { read, request } = readerHarness(async (batch) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      sizes.push(batch.length);
      count++;
      if (count === 1) {
        firstStarted.resolve();
        await release.promise;
      }
      active--;
      return batch.map((property) => ({ ...property, value: 1 }));
    });
    const first = read(addresses(301));
    await firstStarted.promise;
    const second = read([{ did: "device-b", siid: 2, piid: 1 }]);
    expect(request).toHaveBeenCalledTimes(1);
    release.resolve([]);
    const results = await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
    expect(sizes.toSorted((a, b) => a - b)).toEqual([1, 1, 150, 150]);
    expect(results.map((items) => items.length)).toEqual([301, 1]);
  });

  test("aborts callers immediately but retains the slot until transport really ends", async () => {
    const started = deferred();
    const release = deferred<unknown[]>();
    let calls = 0;
    const { read, request } = readerHarness(() => {
      calls++;
      if (calls === 1) {
        started.resolve();
        return release.promise;
      }
      return Promise.resolve([]);
    });
    const controller = new AbortController();
    const first = read(addresses(1), controller);
    await started.promise;
    const cancelled = new Error("cancelled read");
    controller.abort(cancelled);
    await expect(first).rejects.toBe(cancelled);
    const second = read();
    await nextTurn();
    expect(request).toHaveBeenCalledTimes(1);
    release.resolve([]);
    await second;
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("never dispatches a queued request cancelled before it owns the budget", async () => {
    const started = deferred();
    const release = deferred<unknown[]>();
    const { read, request } = readerHarness(() => {
      started.resolve();
      return release.promise;
    });
    const first = read();
    await started.promise;
    const controller = new AbortController();
    const second = read(addresses(1), controller);
    controller.abort(new Error("queued cancellation"));
    await expect(second).rejects.toThrow("queued cancellation");
    release.resolve([]);
    await first;
    await nextTurn();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("authentication failure stops remaining batches and preserves earlier successes", async () => {
    let calls = 0;
    const { read, request } = readerHarness((batch, _signal, onStarted) => {
      onStarted?.("2026-01-02T03:04:05.000Z");
      calls++;
      if (calls === 2)
        return Promise.reject(
          new MiCloudError("authentication", { httpStatus: 401 }),
        );
      return Promise.resolve(
        batch.map((property) => ({ ...property, value: 1 })),
      );
    });
    const results = await read(addresses(451));
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      results.slice(0, 150).every((item) => item.status === "success"),
    ).toBe(true);
    expect(results[150]).toMatchObject({
      status: "unavailable",
      error: { kind: "authentication", http_status: 401 },
      read_started_at: "2026-01-02T03:04:05.000Z",
    });
    expect(
      results.slice(300).every((item) => item.read_started_at === null),
    ).toBe(true);
    expect(results).toHaveLength(451);
  });

  test("Retry-After blocks later batches and renewed credentials of the same source only", async () => {
    let now = Date.now();
    const time = spyOn(Date, "now").mockImplementation(() => now);
    restores.push(() => time.mockRestore());
    const deadline = now + 60_000;
    const reader = new PropertyReader();
    const first = readerHarness(
      () =>
        Promise.reject(
          new MiCloudError("network", {
            httpStatus: 429,
            retryAfterAt: deadline,
          }),
        ),
      reader,
    );
    const original = await first.read(addresses(151));
    expect(first.request).toHaveBeenCalledTimes(1);
    expect(original[150]).toMatchObject({
      read_started_at: null,
      received_at: original[0]?.received_at,
    });

    const renewed = readerHarness(
      (batch) =>
        Promise.resolve(batch.map((property) => ({ ...property, value: 5 }))),
      reader,
    );
    const blocked = await renewed.read();
    expect(renewed.request).not.toHaveBeenCalled();
    expect(blocked[0]).toMatchObject({
      read_started_at: null,
      received_at: original[0]?.received_at,
      error: { retry_after_at: new Date(deadline).toISOString() },
    });
    renewed.context.source_id = "source-b";
    await renewed.read();
    expect(renewed.request).toHaveBeenCalledTimes(1);
    renewed.context.source_id = "source-a";
    now = deadline;
    expect(await renewed.read()).toMatchObject([
      { status: "success", value: 5 },
    ]);
    expect(renewed.request).toHaveBeenCalledTimes(2);
  });
});
