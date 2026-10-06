import { afterEach, expect, test } from "bun:test";
import type { MiotObservation } from "../../src/mijia/protocols/miot/messages";
import { eventually, nextTurn } from "../support/async";
import { runningHousehold } from "../support/household-harness";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
afterEach(async () => {
  for (const household of households.splice(0)) await household.close();
});

// MiLoCo test_prop_subscriptions allows account-wide property subscriptions.
// Home Agent shares account-wide directory notifications with explicitly scoped observations.
test("property observations follow the selected home while directory notifications still cover both homes", async () => {
  const h = await runningHousehold(undefined, {
    homeId: "home-a",
  });
  households.push(h);
  await eventually(() => h.mqtt.transports.length === 1);
  const old = h.mqtt.transports[0]!;
  const propertyTopics = [
    "device/device-a/state/#",
    "device/device-a/up/properties_changed/#",
  ];
  old.connected();
  // Automatic collection already owns the property topics. Leave their shared
  // SUBACKs pending so logout must still reject late confirmations.
  for (let index = 0; index < old.subscriptions.length; index++)
    if (!propertyTopics.includes(old.subscriptions[index]!.topic))
      old.ack(index);
  const initialTopics = old.subscriptions.map(({ topic }) => topic).toSorted();
  expect(initialTopics).toContain("device/device-b/g_op/rename");
  expect(initialTopics).toContain("device/device-b/g_op/hr_change");
  expect(
    initialTopics.filter((topic) => propertyTopics.includes(topic)),
  ).toEqual(propertyTopics);
  expect(initialTopics).not.toContain("device/device-b/state/#");
  expect(initialTopics).not.toContain(
    "device/device-b/up/properties_changed/#",
  );

  // A mixed valid/foreign request must be rejected as a whole, before subscribing either device.
  await expect(
    h.service.observeDevices(
      ["device-a", "device-b"],
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "device_not_found" });
  expect(old.subscriptions.map(({ topic }) => topic).toSorted()).toEqual(
    initialTopics,
  );

  const oldEvents: MiotObservation[] = [];
  await h.service.observeDevices(
    ["device-a"],
    (event) => oldEvents.push(event),
    new AbortController().signal,
  );
  expect(old.subscriptions.map(({ topic }) => topic).toSorted()).toEqual(
    initialTopics,
  );
  expect(
    oldEvents
      .flatMap((event) =>
        event.kind === "subscription" && event.status === "pending"
          ? [event.topic]
          : [],
      )
      .toSorted(),
  ).toEqual(propertyTopics);
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

  await h.runtime.logout();
  for (let index = 0; index < old.subscriptions.length; index++)
    if (propertyTopics.includes(old.subscriptions[index]!.topic))
      old.ack(index);
  old.publish(44, "device-a");
  await nextTurn();
  expect(old.end).toHaveBeenCalledTimes(1);
  expect(oldEvents.filter((event) => event.kind === "property")).toEqual([
    expect.objectContaining({ did: "device-a", value: 11 }),
  ]);
  expect(
    oldEvents.filter(
      (event) => event.kind === "subscription" && event.status === "confirmed",
    ),
  ).toEqual([]);
  expect(h.runtime.snapshot().projection.household.household.home_id).toBe(
    "home-a",
  );
});
