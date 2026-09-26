import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import { AccountObservations } from "../../../src/mijia/account/observations";
import { MiotMqtt } from "../../../src/mijia/protocols/miot/mqtt";
import type { MiotObservation } from "../../../src/mijia/protocols/miot/messages";
import { flushMicrotasks, interceptMqtt, oauth } from "./support";

let transport: ReturnType<typeof interceptMqtt>;
const owners: (AccountObservations | MiotMqtt)[] = [];
beforeEach(() => {
  jest.useFakeTimers();
  transport = interceptMqtt();
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  transport.restore();
  jest.useRealTimers();
});

function observeAccount() {
  const authentication = mock(() => {});
  const permission = mock(() => {});
  let credentials = { ...oauth };
  const owner = new AccountObservations(
    "source",
    () => credentials,
    authentication,
    permission,
  );
  owners.push(owner);
  const events: MiotObservation[] = [];
  const watch = owner.observe(
    ["123"],
    (event) => events.push(event),
    new AbortController().signal,
  );
  return {
    owner,
    watch,
    events,
    authentication,
    permission,
    updateToken(token: string) {
      credentials = { ...credentials, accessToken: token };
      owner.credentialsUpdated();
    },
  };
}

describe("one MQTT generation", () => {
  test("early and duplicate data reach both watchers before SUBACK without confirming subscription", () => {
    const owner = new MiotMqtt("source", oauth, new Map());
    owners.push(owner);
    const first: MiotObservation[] = [];
    const second: MiotObservation[] = [];
    const a = owner.observe(
      ["123"],
      (event) => first.push(event),
      new AbortController().signal,
    );
    owner.observe(
      ["123"],
      (event) => second.push(event),
      new AbortController().signal,
    );
    const wire = transport.transports[0]!;
    wire.connected();
    wire.publish();
    wire.publish();
    expect(wire.subscriptions).toHaveLength(2);
    expect(first.filter((event) => event.kind === "property")).toHaveLength(2);
    expect(owner.snapshot().topics.every((entry) => !entry.confirmed)).toBe(
      true,
    );
    wire.ack(0);
    wire.ack(1);
    a.cancel();
    wire.publish(false);
    expect(first.filter((event) => event.kind === "property")).toHaveLength(2);
    expect(second.filter((event) => event.kind === "property")).toHaveLength(3);
    expect(wire.unsubscriptions).toHaveLength(0);
  });

  test("raw SUBACK rejection wins over requested QoS, temporary failure retries only explicitly", () => {
    const owner = new MiotMqtt("source", oauth, new Map());
    owners.push(owner);
    owner.observe(["123"], () => {}, new AbortController().signal);
    const wire = transport.transports[0]!;
    wire.connected();
    wire.ack(0, 0x80);
    wire.ack(1, 0x87);
    expect(owner.snapshot().topics.map((entry) => entry.confirmed)).toEqual([
      false,
      false,
    ]);
    expect(wire.subscriptions).toHaveLength(2);
    owner.retry();
    expect(wire.subscriptions).toHaveLength(3);
    expect(wire.subscriptions[2]?.topic).toContain("properties_changed");
    wire.ack(2);
    expect(owner.snapshot().topics[0]?.confirmed).toBe(true);
  });

  test("ACK timeout releases the entire generation and late ACK or data cannot resurrect it", async () => {
    const owner = new MiotMqtt("source", oauth, new Map());
    owners.push(owner);
    const events: MiotObservation[] = [];
    owner.observe(
      ["123"],
      (event) => events.push(event),
      new AbortController().signal,
    );
    const wire = transport.transports[0]!;
    wire.connected();
    jest.advanceTimersByTime(10_000);
    await flushMicrotasks();
    expect(owner.snapshot()).toMatchObject({
      status: "closed",
      reason: "ack_timeout",
      in_flight: 0,
      topics: [],
    });
    const delivered = events.length;
    wire.ack(0);
    wire.ack(1);
    wire.publish();
    wire.connected();
    expect(events).toHaveLength(delivered);
    expect(wire.end).toHaveBeenCalledTimes(1);
  });

  test("cancelled devices, directory topics and new devices share one 16-operation budget until ACK", () => {
    // MiLoCo has separate reconciliation/replay limits; this adapter also budgets UNSUBSCRIBE.
    const owner = new MiotMqtt("source", oauth, new Map());
    owners.push(owner);
    const old = owner.observe(
      Array.from({ length: 12 }, (_, index) => `old-${index}`),
      () => {},
      new AbortController().signal,
    );
    const directoryTopics = ["user/1001/g_op/bind", "user/1001/g_op/unbind"];
    owner.observeTopics(
      directoryTopics,
      () => {},
      new AbortController().signal,
    );
    const wire = transport.transports[0]!;
    wire.connected();
    expect(wire.subscriptions).toHaveLength(16);

    old.cancel();
    const newDevices = Array.from({ length: 12 }, (_, index) => `new-${index}`);
    owner.observe(newDevices, () => {}, new AbortController().signal);
    expect(wire.subscriptions).toHaveLength(16);
    expect(wire.unsubscriptions).toHaveLength(0);

    let acknowledgedSubscriptions = 0;
    let acknowledgedUnsubscriptions = 0;
    const outstanding = () =>
      wire.subscriptions.length -
      acknowledgedSubscriptions +
      wire.unsubscriptions.length -
      acknowledgedUnsubscriptions;
    const acknowledgeSubscription = () => {
      wire.ack(acknowledgedSubscriptions++);
      expect(outstanding()).toBeLessThanOrEqual(16);
    };
    const acknowledgeUnsubscription = () => {
      wire.ackUnsubscribe(acknowledgedUnsubscriptions++);
      expect(outstanding()).toBeLessThanOrEqual(16);
    };
    // Late SUBACKs must release capacity only when their replacement UNSUBACKs arrive.
    for (let index = 0; index < 16; index++) acknowledgeSubscription();
    expect(wire.subscriptions).toHaveLength(16);
    expect(wire.unsubscriptions).toHaveLength(16);
    expect(outstanding()).toBe(16);
    acknowledgeUnsubscription();
    expect(wire.subscriptions).toHaveLength(17);
    expect(outstanding()).toBe(16);
    for (let index = 1; index < 16; index++) acknowledgeUnsubscription();

    const expectedTopics = [
      ...directoryTopics,
      ...newDevices.flatMap((did) => [
        `device/${did}/up/properties_changed/#`,
        `device/${did}/state/#`,
      ]),
    ];
    while (acknowledgedSubscriptions < wire.subscriptions.length) {
      expect(acknowledgedSubscriptions).toBeLessThan(
        16 + expectedTopics.length,
      );
      acknowledgeSubscription();
    }
    expect(outstanding()).toBe(0);
    expect(
      new Set(wire.subscriptions.slice(16).map((request) => request.topic)),
    ).toEqual(new Set(expectedTopics));
    expect(
      new Set(wire.unsubscriptions.map((request) => request.topic)),
    ).toEqual(
      new Set(wire.subscriptions.slice(0, 16).map((request) => request.topic)),
    );
    expect(
      new Set(owner.snapshot().topics.map((entry) => entry.topic)),
    ).toEqual(new Set(expectedTopics));
    expect(owner.snapshot().topics.every((entry) => entry.confirmed)).toBe(
      true,
    );
    expect(wire.end).not.toHaveBeenCalled();
  });
});

describe("account watch recovery", () => {
  test("late SUBACK after cancellation cannot restore the old watcher or strand a replacement behind UNSUBACK", async () => {
    // MiLoCo tests subscribe/unsubscribe supersession; shared watchers also allow rejoining mid-unsubscribe.
    const account = observeAccount();
    const directory = account.owner.observeTopics(
      ["user/1001/g_op/bind"],
      () => {},
      new AbortController().signal,
    );
    await flushMicrotasks();
    const wire = transport.transports[0]!;
    wire.connected();
    expect(wire.subscriptions.map((request) => request.topic)).toEqual([
      "device/123/up/properties_changed/#",
      "device/123/state/#",
      "user/1001/g_op/bind",
    ]);
    wire.ack(2);
    account.watch.cancel();
    const cancelledCount = account.events.length;
    wire.publish("after-cancellation");
    expect(wire.unsubscriptions).toHaveLength(0);

    wire.ack(0);
    wire.ack(1);
    expect(wire.unsubscriptions.map((request) => request.topic)).toEqual([
      "device/123/up/properties_changed/#",
      "device/123/state/#",
    ]);
    const replacement: MiotObservation[] = [];
    account.owner.observe(
      ["123"],
      (event) => replacement.push(event),
      new AbortController().signal,
    );
    expect(wire.subscriptions).toHaveLength(3);
    wire.ackUnsubscribe(0);
    wire.ackUnsubscribe(1);
    expect(wire.subscriptions.slice(3).map((request) => request.topic)).toEqual(
      ["device/123/up/properties_changed/#", "device/123/state/#"],
    );
    wire.ack(3);
    wire.ack(4);
    wire.publish("for-replacement");
    expect(account.events).toHaveLength(cancelledCount);
    expect(
      replacement.filter((event) => event.kind === "property"),
    ).toMatchObject([{ did: "123", value: "for-replacement" }]);
    expect(directory.snapshot()).toMatchObject({
      status: "connected",
      observers: 2,
      in_flight: 0,
    });
    expect(transport.transports).toHaveLength(1);
    expect(wire.end).not.toHaveBeenCalled();
  });

  test("directory watch keeps the shared connection alive after device cancellation; failed unsubscribe closes that generation", async () => {
    const account = observeAccount();
    const directory = account.owner.observeTopics(
      ["user/1001/g_op/bind"],
      () => {},
      new AbortController().signal,
    );
    await flushMicrotasks();
    const wire = transport.transports[0]!;
    wire.connected();
    for (let index = 0; index < 3; index++) wire.ack(index);
    account.watch.cancel();
    expect(directory.snapshot()).toMatchObject({
      status: "connected",
      observers: 1,
    });
    expect(wire.end).not.toHaveBeenCalled();
    expect(wire.unsubscriptions.map((entry) => entry.topic)).toEqual([
      "device/123/up/properties_changed/#",
      "device/123/state/#",
    ]);
    wire.ackUnsubscribe(0, 0x80);
    expect(directory.snapshot()).toMatchObject({
      status: "closed",
      reason: "unsubscribe_failed",
      reconnect_scheduled: true,
    });
  });

  test("reconnect uses capped 1/2/4 second backoff, resets after connect, and last cancellation stops recovery", async () => {
    const { watch } = observeAccount();
    await flushMicrotasks();
    for (const delay of [
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 120_000, 120_000,
    ]) {
      const count = transport.transports.length;
      transport.transports.at(-1)!.client.emit("close");
      await flushMicrotasks();
      jest.advanceTimersByTime(delay - 1);
      await flushMicrotasks();
      expect(transport.transports).toHaveLength(count);
      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(transport.transports).toHaveLength(count + 1);
    }
    const recovered = transport.transports.at(-1)!;
    recovered.connected();
    recovered.ack(0);
    recovered.ack(1);
    recovered.client.emit("close");
    await flushMicrotasks();
    const count = transport.transports.length;
    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(transport.transports).toHaveLength(count + 1);
    transport.transports.at(-1)!.client.emit("close");
    watch.cancel();
    jest.advanceTimersByTime(120_000);
    await flushMicrotasks();
    expect(transport.transports).toHaveLength(count + 1);
    expect(watch.snapshot()).toMatchObject({
      observers: 0,
      reconnect_scheduled: false,
    });
  });

  test("topic ACL rejection is retained across reconnect, does not refresh token, and credentials clear it", async () => {
    const account = observeAccount();
    await flushMicrotasks();
    const first = transport.transports[0]!;
    first.connected();
    first.ack(0, 0x87);
    first.ack(1);
    expect(account.permission).toHaveBeenCalledTimes(1);
    expect(account.authentication).not.toHaveBeenCalled();
    first.client.emit("close");
    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();
    const next = transport.transports[1]!;
    next.connected();
    expect(next.subscriptions.map((entry) => entry.topic)).toEqual([
      "device/123/state/#",
    ]);
    expect(account.permission).toHaveBeenCalledTimes(1);
    next.ack(0);
    account.updateToken("new-token");
    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();
    const refreshed = transport.transports[2]!;
    refreshed.connected();
    expect(refreshed.subscriptions).toHaveLength(2);
    expect(transport.factory.mock.calls.at(-1)?.[1]).toMatchObject({
      password: "new-token",
    });
  });

  test("explicit connection authentication failure pauses retries until credentials change", async () => {
    const account = observeAccount();
    await flushMicrotasks();
    transport.transports[0]!.client.emit("packetreceive", {
      cmd: "connack",
      sessionPresent: false,
      reasonCode: 135,
    });
    await flushMicrotasks();
    jest.advanceTimersByTime(120_000);
    await flushMicrotasks();
    account.watch.retry();
    expect(account.authentication).toHaveBeenCalledTimes(1);
    expect(account.permission).not.toHaveBeenCalled();
    expect(account.watch.snapshot()).toMatchObject({
      authentication_failed: true,
      reconnect_scheduled: false,
    });
    expect(transport.transports).toHaveLength(1);
    account.updateToken("renewed");
    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(transport.transports).toHaveLength(2);
    expect(account.watch.snapshot().authentication_failed).toBe(false);
  });

  test("synchronous abort during first callback leaves no binding or reconnect task; idle refresh stays idle", async () => {
    const owner = new AccountObservations(
      "source",
      () => oauth,
      () => {},
      () => {},
    );
    owners.push(owner);
    const controller = new AbortController();
    const listener = mock(() => controller.abort());
    const watch = owner.observe(["123"], listener, controller.signal);
    await flushMicrotasks();
    expect(watch.snapshot()).toMatchObject({
      observers: 0,
      reconnect_scheduled: false,
      topics: [],
    });
    owner.credentialsUpdated();
    jest.advanceTimersByTime(120_000);
    await flushMicrotasks();
    expect(transport.transports).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
