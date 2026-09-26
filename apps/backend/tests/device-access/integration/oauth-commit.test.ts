import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { MiCloudError } from "../../../src/mijia/protocols/micloud/errors";
import { accountSessionSchema } from "../../../src/mijia/account/session";
import { accountClient } from "../../support/protocol-fixtures";
import { deferred, nextTurn } from "../../support/async";
import {
  holdCredentialWrite,
  runningHousehold,
} from "../../support/household-harness";
import type { MiotObservation } from "../../../src/mijia/protocols/miot/messages";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
const releaseBarriers: (() => void)[] = [];
afterEach(async () => {
  for (const release of releaseBarriers.splice(0)) release();
  for (const household of households.splice(0)) await household.close();
  mock.restore();
  jest.useRealTimers();
});

/** Leave the real local media peer untouched; gate only the OAuth HTTP boundary. */
function oauthBoundary() {
  const original = globalThis.fetch;
  const replies: ReturnType<typeof deferred<Response>>[] = [];
  const requests: URL[] = [];
  const request = (
    input: Parameters<typeof original>[0],
    init?: Parameters<typeof original>[1],
  ) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://mico.api.mijia.tech")
      return original(input, init);
    requests.push(url);
    const reply = deferred<Response>();
    replies.push(reply);
    return reply.promise;
  };
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(request, { preconnect: original.preconnect }),
  );
  releaseBarriers.push(() => {
    for (const reply of replies)
      reply.resolve(new Response(null, { status: 503 }));
  });
  return { replies, requests };
}

function tokenResponse(accessToken: string) {
  return Response.json({
    code: 0,
    result: {
      access_token: accessToken,
      refresh_token: "updated-refresh",
      expires_in: 3600,
    },
  });
}

function connectCurrent(
  household: Awaited<ReturnType<typeof runningHousehold>>,
) {
  const wire = household.mqtt.transports.at(-1)!;
  wire.connected();
  for (let index = 0; index < wire.subscriptions.length; index++)
    wire.ack(index);
  return wire;
}

async function rejectDuringCommit() {
  const household = await runningHousehold();
  households.push(household);
  household.renewal.mockImplementation(async () => accountClient());
  const events: MiotObservation[] = [];
  const watch = await household.service.observeDevices(
    ["device-a"],
    (event) => events.push(event),
    new AbortController().signal,
  );
  const wire = connectCurrent(household);
  const oauth = oauthBoundary();
  const write = holdCredentialWrite(household);
  releaseBarriers.push(write.release);
  jest.useFakeTimers();

  // A MiCloud property authentication failure starts ordinary complete-session
  // renewal. MQTT remains active until its separate rejection below.
  household.properties.mockRejectedValueOnce(
    new MiCloudError("authentication", { httpStatus: 401 }),
  );
  const read = await household.service.readProperties(
    [{ did: "device-a", siid: 2, piid: 1 }],
    new AbortController().signal,
  );
  expect(read[0]).toMatchObject({
    status: "unavailable",
    error: { kind: "authentication" },
  });
  const [, candidate] = await write.started;
  expect(accountSessionSchema.parse(candidate).oauth.accessToken).toBe(
    "test-access-token",
  );
  expect(oauth.requests).toHaveLength(0);
  expect(watch.snapshot().status).toBe("connected");

  // This is the vendor SDK event consumed by the real MQTT/account owners.
  wire.client.emit("disconnect", { cmd: "disconnect", reasonCode: 135 });
  expect(watch.snapshot()).toMatchObject({
    authentication_failed: true,
    reconnect_scheduled: false,
  });
  jest.advanceTimersByTime(2_000);
  await nextTurn();
  expect(household.mqtt.transports).toHaveLength(1);
  expect(oauth.requests).toHaveLength(0);
  write.release();
  await write.committed;
  await nextTurn();
  // Committing ordinary renewal must carry the rejection to its new account owner.
  expect(oauth.requests).toHaveLength(1);
  expect(oauth.requests[0]?.pathname).toBe("/app/v2/mico/oauth/get_token");
  expect(watch.snapshot().authentication_failed).toBe(true);
  return { household, watch, events, oauth };
}

async function storedToken(
  household: Awaited<ReturnType<typeof runningHousehold>>,
) {
  const record = await household.store.read("mijia");
  return accountSessionSchema.parse(record?.value).oauth.accessToken;
}

describe("MQTT rejection during durable account renewal", () => {
  test("the rejection survives commit and the existing watch reconnects only after a different token is persisted", async () => {
    const { household, watch, oauth, events } = await rejectDuringCommit();
    expect(await storedToken(household)).toBe("test-access-token");
    jest.advanceTimersByTime(2_000);
    await nextTurn();
    expect(household.mqtt.transports).toHaveLength(1);
    const replacement = holdCredentialWrite(household);
    releaseBarriers.push(replacement.release);
    oauth.replies[0]!.resolve(tokenResponse("replacement-token"));
    const [, credentials] = await replacement.started;
    expect(accountSessionSchema.parse(credentials).oauth.accessToken).toBe(
      "replacement-token",
    );
    expect(await storedToken(household)).toBe("test-access-token");
    jest.advanceTimersByTime(2_000);
    await nextTurn();
    expect(watch.snapshot().authentication_failed).toBe(true);
    expect(household.mqtt.transports).toHaveLength(1);
    replacement.release();
    await replacement.committed;
    await nextTurn();
    expect(await storedToken(household)).toBe("replacement-token");
    expect(watch.snapshot()).toMatchObject({
      authentication_failed: false,
      reconnect_scheduled: true,
    });
    jest.advanceTimersByTime(1_000);
    await nextTurn();
    expect(household.mqtt.transports).toHaveLength(2);
    expect(household.mqtt.factory.mock.calls.at(-1)?.[1]).toMatchObject({
      password: "replacement-token",
    });
    const restored = connectCurrent(household);
    const topic = "device/device-a/up/properties_changed";
    const payload = Buffer.from(
      JSON.stringify({
        method: "properties_changed",
        params: { did: "device-a", siid: 2, piid: 1, value: 24 },
      }),
    );
    restored.client.emit("message", topic, payload, {
      cmd: "publish",
      topic,
      payload,
      qos: 0,
      retain: false,
      dup: false,
    });
    expect(events.filter((event) => event.kind === "property")).toEqual([
      expect.objectContaining({
        did: "device-a",
        value: 24,
        collection_generation: watch.snapshot().generation,
      }),
    ]);
    expect(household.runtime.ready).toBe(true);
  });

  test("a forced refresh returning the rejected token revokes the whole account and its previous watch", async () => {
    const { household, watch, oauth } = await rejectDuringCommit();
    const epoch = household.runtime.epoch;
    oauth.replies[0]!.resolve(tokenResponse("test-access-token"));
    await nextTurn();
    expect(household.service.snapshot().account).toMatchObject({
      status: "reauth_required",
      error: { code: "mijia_authentication" },
    });
    expect(household.service.identity()).toBeNull();
    expect(household.runtime.ready).toBe(false);
    expect(household.runtime.epoch).not.toBe(epoch);
    expect(watch.snapshot().observers).toBe(0);
    await expect(
      household.service.readProperties(
        [{ did: "device-a", siid: 2, piid: 1 }],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "devices_failed" });
    jest.advanceTimersByTime(120_000);
    await nextTurn();
    expect(household.mqtt.transports).toHaveLength(1);
    expect(oauth.requests).toHaveLength(1);
  });

  test("rate limiting preserves the rejected-token pause and manual retry cannot bypass Retry-After", async () => {
    const { household, watch, oauth } = await rejectDuringCommit();
    oauth.replies[0]!.resolve(
      new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
    );
    await nextTurn();
    expect(household.service.snapshot().account.status).toBe("authenticated");
    expect(household.runtime.ready).toBe(true);
    expect(watch.snapshot()).toMatchObject({
      authentication_failed: true,
      reconnect_scheduled: false,
    });
    household.service.requestConnection();
    await nextTurn();
    expect(household.service.snapshot().connectionOperation?.status).toBe(
      "failed",
    );
    jest.advanceTimersByTime(59_999);
    await nextTurn();
    household.service.requestConnection();
    await nextTurn();
    expect(oauth.requests).toHaveLength(1);
    expect(household.mqtt.transports).toHaveLength(1);
    expect(await storedToken(household)).toBe("test-access-token");
    jest.advanceTimersByTime(1);
    await nextTurn();
    expect(oauth.requests).toHaveLength(2);
    expect(watch.snapshot().authentication_failed).toBe(true);
    oauth.replies[1]!.resolve(tokenResponse("after-deadline-token"));
    await nextTurn();
    expect(await storedToken(household)).toBe("after-deadline-token");
    jest.advanceTimersByTime(1_000);
    await nextTurn();
    expect(household.mqtt.factory.mock.calls.at(-1)?.[1]).toMatchObject({
      password: "after-deadline-token",
    });
    expect(household.mqtt.transports).toHaveLength(2);
  });
});
