import { afterEach, expect, test } from "bun:test";
import type { MiotObservation } from "../../../src/mijia/protocols/miot/messages";
import { eventually, nextTurn } from "../../support/async";
import { runningHousehold } from "../../support/household-harness";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
afterEach(async () => {
  for (const household of households.splice(0)) await household.close();
});

// MiLoCo test_prop_subscriptions allows account-wide property subscriptions.
// Home Agent shares account-wide directory notifications with explicitly scoped observations.
test("property observations follow the selected home while directory notifications still cover both homes", async () => {
  const h = await runningHousehold();
  households.push(h);
  await eventually(() => h.mqtt.transports.length === 1);
  const old = h.mqtt.transports[0]!;
  old.connected();
  for (let index = 0; index < old.subscriptions.length; index++) old.ack(index);
  const directoryTopics = old.subscriptions
    .map(({ topic }) => topic)
    .toSorted();
  expect(directoryTopics).toContain("device/device-b/g_op/rename");
  expect(directoryTopics).toContain("device/device-b/g_op/hr_change");

  // A mixed valid/foreign request must be rejected as a whole, before subscribing either device.
  await expect(
    h.service.observeDevices(
      ["device-a", "device-b"],
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "device_not_found" });
  expect(old.subscriptions.map(({ topic }) => topic).toSorted()).toEqual(
    directoryTopics,
  );

  const oldEvents: MiotObservation[] = [];
  await h.service.observeDevices(
    ["device-a"],
    (event) => oldEvents.push(event),
    new AbortController().signal,
  );
  const propertySubscriptions = old.subscriptions.slice(directoryTopics.length);
  expect(propertySubscriptions.map(({ topic }) => topic).toSorted()).toEqual([
    "device/device-a/state/#",
    "device/device-a/up/properties_changed/#",
  ]);
  // Keep these SUBACKs pending so the later home switch must also reject late confirmations.
  old.publish(11, "device-a");
  old.publish(22, "device-b");
  old.publish(33, "stable");
  expect(oldEvents.filter((event) => event.kind === "property")).toEqual([
    expect.objectContaining({ did: "device-a", value: 11 }),
  ]);

  const notificationTopic = "device/device-b/g_op/rename";
  const payload = Buffer.from('{"name":"untrusted-notification"}');
  const received = h.service.directoryPushStatus().received;
  old.client.emit("message", notificationTopic, payload, {
    cmd: "publish",
    topic: notificationTopic,
    payload,
    qos: 0,
    dup: false,
    retain: false,
  });
  expect(h.service.directoryPushStatus().received).toBe(received + 1);

  h.runtime.selectHome(h.runtime.epoch, "home-b");
  await eventually(
    () =>
      h.runtime.ready &&
      h.runtime.snapshot().projection.household.household.home_id ===
        "home-b" &&
      h.mqtt.transports.length === 2,
  );
  const current = h.mqtt.transports[1]!;
  current.connected();
  for (let index = 0; index < current.subscriptions.length; index++)
    current.ack(index);
  expect(current.subscriptions.map(({ topic }) => topic).toSorted()).toEqual(
    directoryTopics,
  );
  expect(old.end).toHaveBeenCalledTimes(1);

  const currentEvents: MiotObservation[] = [];
  const watch = await h.service.observeDevices(
    ["device-b"],
    (event) => currentEvents.push(event),
    new AbortController().signal,
  );
  expect(
    current.subscriptions
      .slice(directoryTopics.length)
      .map(({ topic }) => topic)
      .toSorted(),
  ).toEqual([
    "device/device-b/state/#",
    "device/device-b/up/properties_changed/#",
  ]);
  for (
    let index = directoryTopics.length;
    index < old.subscriptions.length;
    index++
  )
    old.ack(index);
  for (
    let index = directoryTopics.length;
    index < current.subscriptions.length;
    index++
  )
    current.ack(index);
  old.publish(44, "device-a");
  old.publish(55, "device-b");
  current.publish(66, "device-a");
  current.publish(77, "device-b");
  await nextTurn();
  expect(oldEvents.filter((event) => event.kind === "property")).toEqual([
    expect.objectContaining({ did: "device-a", value: 11 }),
  ]);
  expect(
    oldEvents.filter(
      (event) => event.kind === "subscription" && event.status === "confirmed",
    ),
  ).toEqual([]);
  expect(currentEvents.filter((event) => event.kind === "property")).toEqual([
    expect.objectContaining({
      did: "device-b",
      value: 77,
      collection_generation: watch.snapshot().generation,
    }),
  ]);
  await expect(
    h.service.observeDevices(
      ["device-a"],
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "device_not_found" });
});
