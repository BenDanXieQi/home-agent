import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { MiCloudError } from "../../../src/mijia/protocols/micloud";
import { deferred, nextTurn } from "../../support/async";
import { runningHousehold } from "../../support/household-harness";
import { accountClient } from "../../support/protocol-fixtures";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
const releases: (() => void)[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const fixture of households.splice(0)) await fixture.close();
  for (const restore of restores.splice(0).toReversed()) restore();
});

async function household() {
  const result = await runningHousehold();
  households.push(result);
  return result;
}

function read(h: Awaited<ReturnType<typeof runningHousehold>>) {
  return h.service.readProperties(
    [{ did: "device-a", siid: 2, piid: 1 }],
    new AbortController().signal,
  );
}

async function renew(h: Awaited<ReturnType<typeof runningHousehold>>) {
  h.renewal.mockResolvedValueOnce(
    accountClient({ serviceToken: "renewed-service-token" }),
  );
  // A directory authentication failure enters the public maintenance path.
  // The replacement has the same account and unchanged device membership.
  h.catalog.mockRejectedValueOnce(new MiCloudError("authentication"));
  await h.service.loadDevices();
  expect(h.service.snapshot().account.status).toBe("authenticated");
  expect(h.runtime.ready).toBe(true);
  expect(h.renewal).toHaveBeenCalledTimes(2);
}

describe("property reads across successful same-account renewal", () => {
  test("renewal rejects old in-flight and queued reads while new reads retain the source with a new generation", async () => {
    const h = await household();
    const [before] = await read(h);
    expect(before).toMatchObject({
      status: "success",
      source_id: expect.any(String),
      collection_generation: expect.any(String),
    });
    const started = deferred<AbortSignal | undefined>();
    const response = deferred<Awaited<ReturnType<typeof h.properties>>>();
    const release = () =>
      response.resolve([{ did: "device-a", siid: 2, piid: 1, value: 99 }]);
    releases.push(release);
    h.properties.mockImplementationOnce((_batch, signal, onStarted) => {
      onStarted?.(new Date().toISOString());
      started.resolve(signal);
      return response.promise;
    });
    const inFlight = read(h).then(
      (observations) => ({ accepted: true, observations }),
      () => ({ accepted: false }),
    );
    const signal = await started.promise;
    const queued = read(h).then(
      (observations) => ({ accepted: true, observations }),
      () => ({ accepted: false }),
    );
    expect(h.properties).toHaveBeenCalledTimes(2);

    await renew(h);
    expect(signal?.aborted).toBe(true);
    expect(await inFlight).toEqual({ accepted: false });
    expect(await queued).toEqual({ accepted: false });
    const current = read(h);
    await nextTurn();
    // Cancellation cannot release the shared transport budget early.
    expect(h.properties).toHaveBeenCalledTimes(2);
    release();
    const [after] = await current;
    expect(after).toMatchObject({
      status: "success",
      value: 21,
      source_id: before?.source_id,
    });
    expect(after?.collection_generation).not.toBe(
      before?.collection_generation,
    );
    expect(h.properties).toHaveBeenCalledTimes(3);
  });

  test("renewed credentials cannot bypass the same account's supplier Retry-After deadline", async () => {
    const h = await household();
    const [before] = await read(h);
    expect(before).toMatchObject({
      status: "success",
      source_id: expect.any(String),
      collection_generation: expect.any(String),
    });
    let now = Date.now();
    const time = spyOn(Date, "now").mockImplementation(() => now);
    restores.push(() => time.mockRestore());
    const deadline = now + 60_000;
    h.properties.mockRejectedValueOnce(
      new MiCloudError("network", { httpStatus: 429, retryAfterAt: deadline }),
    );
    const [limited] = await read(h);
    expect(limited).toMatchObject({
      status: "unavailable",
      error: { http_status: 429 },
    });
    await renew(h);

    const [blocked] = await read(h);
    expect(blocked).toMatchObject({
      status: "unavailable",
      source_id: before?.source_id,
      read_started_at: null,
      received_at: limited?.received_at,
      error: {
        http_status: 429,
        retry_after_at: new Date(deadline).toISOString(),
      },
    });
    expect(blocked?.collection_generation).not.toBe(
      before?.collection_generation,
    );
    now = deadline - 1;
    await read(h);
    expect(h.properties).toHaveBeenCalledTimes(2);
    now = deadline;
    expect(await read(h)).toMatchObject([
      {
        status: "success",
        value: 21,
        source_id: before?.source_id,
        collection_generation: blocked?.collection_generation,
      },
    ]);
    expect(h.properties).toHaveBeenCalledTimes(3);
  });
});
