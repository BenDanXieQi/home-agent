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
import { DirectoryNotifications } from "../../../src/mijia/devices/directory-notifications";
import { flushMicrotasks, interceptMqtt, oauth } from "./support";

let transport: ReturnType<typeof interceptMqtt>;
const accounts: AccountObservations[] = [];
const notifications: DirectoryNotifications[] = [];
beforeEach(() => {
  jest.useFakeTimers();
  transport = interceptMqtt();
});
afterEach(async () => {
  for (const owner of notifications.splice(0)) owner.close();
  await Promise.all(accounts.splice(0).map((owner) => owner.close()));
  transport.restore();
  jest.useRealTimers();
});

function account() {
  const owner = new AccountObservations(
    "directory-source",
    () => oauth,
    () => {},
    () => {},
  );
  accounts.push(owner);
  return owner;
}

function connected(connectionIndex = 0) {
  const wire = transport.transports[connectionIndex]!;
  wire.connected();
  for (let index = 0; index < wire.subscriptions.length; index++)
    wire.ack(index);
  return wire;
}

function notify(
  wire: ReturnType<typeof connected>,
  topic = "device/123/g_op/rename",
) {
  const payload = Buffer.from('{"name":"not-authoritative"}');
  wire.client.emit("message", topic, payload, {
    cmd: "publish",
    topic,
    payload,
    qos: 0,
    dup: false,
    retain: false,
  });
}

async function setup() {
  const owner = account();
  const refresh = mock(async () => {});
  const directory = new DirectoryNotifications(refresh);
  notifications.push(directory);
  directory.update(owner, "1001", ["123"]);
  await flushMicrotasks();
  return { owner, directory, refresh };
}

describe("account directory invalidation", () => {
  test("each successful connection schedules an authoritative refresh even without a notification", async () => {
    const { directory, refresh } = await setup();
    const first = connected();
    expect(directory.snapshot()).toMatchObject({
      confirmed: 4,
      received: 0,
      refresh_pending: true,
    });
    jest.advanceTimersByTime(4_999);
    expect(refresh).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    first.client.emit("close");
    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();
    connected(1);
    jest.advanceTimersByTime(4_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(directory.snapshot().received).toBe(0);
  });

  test("bursts refresh once five seconds after their tail; unchanged inventory cannot postpone that refresh", async () => {
    const { owner, directory, refresh } = await setup();
    const wire = connected();
    jest.advanceTimersByTime(4_000);
    notify(wire);
    jest.advanceTimersByTime(4_000);
    notify(wire, "user/1001/g_op/bind");
    jest.advanceTimersByTime(4_999);
    expect(refresh).not.toHaveBeenCalled();
    directory.update(owner, "1001", ["123", "123"]);
    jest.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]).toEqual([]);
    expect(directory.snapshot()).toMatchObject({
      received: 2,
      refresh_pending: false,
    });
    expect(transport.transports).toHaveLength(1);
    expect(wire.end).not.toHaveBeenCalled();
  });

  test("replacing the account rejects the old timer and late packets, then refreshes only the current scope", async () => {
    const { directory, refresh } = await setup();
    const old = connected();
    notify(old);
    jest.advanceTimersByTime(1_000);
    directory.update(account(), "2002", ["456"]);
    await flushMicrotasks();
    notify(old);
    old.connected();
    jest.advanceTimersByTime(4_000);
    expect(refresh).not.toHaveBeenCalled();
    const current = connected(1);
    // A valid old topic on the new transport still has no current consumer.
    notify(current);
    expect(directory.snapshot().received).toBe(1);
    jest.advanceTimersByTime(4_000);
    notify(current, "device/456/g_op/hr_change");
    jest.advanceTimersByTime(4_999);
    expect(refresh).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(directory.snapshot().received).toBe(2);
  });

  test("closing revokes a pending refresh and all late connection or message callbacks", async () => {
    const { directory, refresh } = await setup();
    const wire = connected();
    notify(wire);
    directory.close();
    notify(wire);
    wire.connected();
    jest.advanceTimersByTime(120_000);
    await flushMicrotasks();
    expect(refresh).not.toHaveBeenCalled();
    expect(directory.snapshot()).toMatchObject({
      status: "inactive",
      topics: 0,
      received: 0,
      refresh_pending: false,
    });
    expect(transport.transports).toHaveLength(1);
    expect(wire.end).toHaveBeenCalledTimes(1);
  });
});
