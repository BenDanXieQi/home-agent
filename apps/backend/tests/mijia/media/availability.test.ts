import { afterEach, expect, spyOn, test } from "bun:test";
import { createPerceptionSources } from "../../../src/mijia/perception-source";
import {
  householdCatalog,
  runningHousehold,
} from "../../support/household-harness";
import { eventually, nextTurn } from "../../support/async";

const fixtures: Awaited<ReturnType<typeof runningHousehold>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function offlineCamera() {
  const catalog = householdCatalog();
  catalog.devices[0]!.model = "test.camera.single";
  const fixture = await runningHousehold(catalog);
  fixtures.push(fixture);
  await eventually(
    () => fixture.service.sourceSnapshot().binding.status === "ready",
  );
  return {
    ...fixture,
    sources: createPerceptionSources(fixture.runtime, fixture.service),
    async online(value: boolean) {
      fixture.catalog.mockResolvedValue({
        ...catalog,
        devices: catalog.devices.map((device) =>
          device.did === "device-a" ? { ...device, isOnline: value } : device,
        ),
      });
      await fixture.service.loadDevices();
    },
  };
}

test("offline capture waits for accepted online state without revoking recording access", async () => {
  const fixture = await offlineCamera();
  const source = { deviceId: "device-a", channel: 1 as const };
  const access = fixture.sources.eligibility(source);
  expect(access).not.toBeNull();
  const catalogReads = fixture.catalog.mock.calls.length;
  const wire = fixture.mqtt.transports[0]!;
  wire.connected();
  await eventually(() =>
    wire.subscriptions.some(({ topic }) => topic === "device/device-a/state/#"),
  );
  function notifyOnline(online: boolean) {
    const topic = `device/device-a/state/${online ? "online" : "offline"}`;
    const payload = Buffer.from("{}");
    wire.client.emit("message", topic, payload, {
      cmd: "publish",
      topic,
      payload,
      qos: 0,
      dup: false,
      retain: false,
    });
  }
  const controller = new AbortController();
  const pending = fixture.sources.prepare(source, controller.signal);
  try {
    await nextTurn();
    expect(fixture.peer.calls.filter((call) => call.path === "camera")).toEqual(
      [],
    );

    notifyOnline(true);
    const prepared = await pending;
    expect(prepared.signal.aborted).toBe(false);
    expect(fixture.sources.eligibility(source)?.identity).toBe(
      access?.identity,
    );
    expect(
      fixture.peer.calls.filter(
        (call) => call.path === "camera" && call.method === "PUT",
      ),
    ).toHaveLength(1);

    notifyOnline(false);
    await eventually(() => prepared.signal.aborted);
    expect(prepared.signal.aborted).toBe(true);
    expect(fixture.sources.eligibility(source)?.identity).toBe(
      access?.identity,
    );
    expect(fixture.sources.eligibility(source)?.householdVersion).toEqual(
      fixture.runtime.version(),
    );
    expect(fixture.catalog.mock.calls.length).toBe(catalogReads);
  } finally {
    controller.abort();
    await Promise.allSettled([pending]);
  }
});

test("cancelling an offline capture prevents a later online notification from starting it", async () => {
  const fixture = await offlineCamera();
  const controller = new AbortController();
  const analysis = spyOn(fixture.service, "prepareAnalysis");
  try {
    const pending = fixture.sources.prepare(
      { deviceId: "device-a", channel: 1 },
      controller.signal,
    );
    const reason = new Error("Capture stopped");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    await fixture.online(true);
    await nextTurn();
    expect(analysis).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    analysis.mockRestore();
  }
});
