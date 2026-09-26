import { afterEach, expect, spyOn, test } from "bun:test";
import { MijiaError } from "../../src/mijia/errors";
import { HouseholdError } from "../../src/household/errors";
import type { MiotObservation } from "../../src/mijia/protocols/miot/messages";
import { MiCloudError } from "../../src/mijia/protocols/micloud";
import { MiotSpecClient } from "../../src/mijia/protocols/spec/client";
import { specUrn } from "../support/protocol-fixtures";
import { deferred, eventually, nextTurn } from "../support/async";
import {
  householdCatalog,
  runningHousehold,
} from "../support/household-harness";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const household of households.splice(0)) await household.close();
});

function cameraCatalog() {
  const catalog = householdCatalog();
  for (const did of ["camera-a", "camera-b"]) {
    catalog.devices.push({
      ...catalog.devices[0]!,
      did,
      model: "test.camera.single",
    });
    catalog.homes[0]!.deviceIds.push(did);
  }
  return catalog;
}

function withoutDevice(
  catalog: ReturnType<typeof householdCatalog>,
  did: string,
) {
  return {
    ...catalog,
    homes: catalog.homes.map((home) => ({
      ...home,
      deviceIds: home.deviceIds.filter((id) => id !== did),
    })),
    devices: catalog.devices.filter((device) => device.did !== did),
  };
}

test("a device revocation commits before cancellation, preserves peers and cannot revive an old read or watch", async () => {
  const catalog = cameraCatalog();
  const h = await runningHousehold(catalog);
  households.push(h);
  await eventually(() => h.service.snapshot().binding.status === "ready");
  const revision = h.service.snapshot().revision;
  const viewer = h.runtime.reservePlayback(
    h.runtime.epoch,
    revision,
    "camera-a",
    1,
  );
  await h.service.offer(
    revision,
    viewer.id,
    "fixture-offer",
    new AbortController().signal,
  );

  const transport = h.mqtt.transports[0]!;
  transport.connected();
  for (let index = 0; index < transport.subscriptions.length; index++)
    transport.ack(index);
  const events: MiotObservation[] = [];
  await h.service.observeDevices(
    ["device-a", "stable"],
    (event) => events.push(event),
    new AbortController().signal,
  );
  for (let index = 0; index < transport.subscriptions.length; index++)
    transport.ack(index);
  const stableSubscriptions = transport.subscriptions.filter(({ topic }) =>
    topic.includes("/stable/"),
  ).length;

  const entered = deferred<AbortSignal | undefined>();
  const response = deferred<Awaited<ReturnType<typeof h.properties>>>();
  h.properties.mockImplementationOnce((_batch, signal) => {
    entered.resolve(signal);
    return response.promise;
  });
  const release = () =>
    response.resolve([{ did: "device-a", siid: 2, piid: 1, value: 99 }]);
  releases.push(release);
  const read = (did: string) =>
    h.service.readProperties(
      [{ did, siid: 2, piid: 1 }],
      new AbortController().signal,
    );
  const revokedRead = read("device-a").then(
    () => true,
    () => false,
  );
  const requestSignal = await entered.promise;
  let committedAtCancellation = false;
  requestSignal?.addEventListener("abort", () => {
    committedAtCancellation = !Object.values(
      h.runtime.snapshot().projection.device,
    ).some((device) => device.id === "device-a");
  });
  const stableRead = read("stable");

  h.catalog.mockResolvedValue(withoutDevice(catalog, "device-a"));
  h.repository.save.mockRejectedValueOnce(new MijiaError("home_storage"));
  await h.service.loadDevices();
  expect(committedAtCancellation).toBe(true);
  expect(await revokedRead).toBe(false);
  expect(h.runtime.ready).toBe(true);
  expect(h.service.snapshot().revision).toBe(revision);
  expect(h.service.playbackSnapshot(viewer.id).phase).toBe("active");
  expect(transport.end).not.toHaveBeenCalled();
  expect(h.mqtt.transports).toHaveLength(1);
  transport.publish(22, "device-a");
  transport.publish(33, "stable");
  expect(events.filter((event) => event.kind === "property")).toMatchObject([
    { did: "stable", value: 33 },
  ]);
  expect(
    transport.unsubscriptions.some(({ topic }) => topic.includes("/stable/")),
  ).toBe(false);

  h.catalog.mockResolvedValue(catalog);
  await h.service.loadDevices();
  release();
  expect(await stableRead).toMatchObject([
    { did: "stable", status: "success", value: 21 },
  ]);
  transport.publish(44, "device-a");
  transport.publish(55, "stable");
  await nextTurn();
  expect(events.filter((event) => event.kind === "property")).toMatchObject([
    { did: "stable", value: 33 },
    { did: "stable", value: 55 },
  ]);
  expect(
    transport.subscriptions.filter(({ topic }) => topic.includes("/stable/"))
      .length,
  ).toBe(stableSubscriptions);
  expect(await read("device-a")).toMatchObject([
    { status: "success", value: 21 },
  ]);
});

test("removing a camera releases its reserved and active viewers while another camera keeps playing", async () => {
  const catalog = cameraCatalog();
  const h = await runningHousehold(catalog);
  households.push(h);
  await eventually(() => h.service.snapshot().binding.status === "ready");
  const revision = h.service.snapshot().revision;
  const reserved = h.runtime.reservePlayback(
    h.runtime.epoch,
    revision,
    "camera-a",
    1,
  );
  const active = h.runtime.reservePlayback(
    h.runtime.epoch,
    revision,
    "camera-a",
    1,
  );
  const stable = h.runtime.reservePlayback(
    h.runtime.epoch,
    revision,
    "camera-b",
    1,
  );
  for (const viewer of [active, stable])
    await h.service.offer(
      revision,
      viewer.id,
      "fixture-offer",
      new AbortController().signal,
    );
  h.catalog.mockResolvedValue(withoutDevice(catalog, "camera-a"));
  await h.service.loadDevices();
  expect(() => h.service.playbackSnapshot(reserved.id)).toThrow();
  expect(() => h.service.playbackSnapshot(active.id)).toThrow();
  expect(h.service.playbackSnapshot(stable.id).phase).toBe("active");
  expect(h.service.snapshot().revision).toBe(revision);
});

test("a changed device definition retains display capabilities but cannot authorize new reads with them", async () => {
  const h = await runningHousehold();
  households.push(h);
  const previous = Object.values(h.runtime.snapshot().projection.device).find(
    (device) => device.id === "device-a",
  )!;
  const previousSpec = h.runtime.specification("stable").spec;
  const nextUrn = specUrn.replace(/:1$/, ":2");
  spyOn(MiotSpecClient.prototype, "resolve").mockImplementation(
    (_device, signal) =>
      Promise.resolve({ urn: nextUrn, requestSignal: signal }),
  );
  spyOn(MiotSpecClient.prototype, "read").mockRejectedValue(
    new MiCloudError("spec-invalid-response"),
  );
  const entered = deferred<AbortSignal | undefined>();
  const response = deferred<Awaited<ReturnType<typeof h.properties>>>();
  h.properties.mockImplementationOnce((_batch, signal) => {
    entered.resolve(signal);
    return response.promise;
  });
  releases.push(() =>
    response.resolve([{ did: "device-a", siid: 2, piid: 1, value: 99 }]),
  );
  const oldRead = h.service
    .readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    )
    .then(
      () => true,
      () => false,
    );
  const requestSignal = await entered.promise;
  const next = householdCatalog();
  const replacement = next.devices.find((device) => device.did === "device-a")!;
  replacement.model = "test.sensor.replacement";
  replacement.spec_type = nextUrn;
  h.catalog.mockResolvedValue(next);
  h.repository.save.mockRejectedValueOnce(new MijiaError("home_storage"));
  await h.service.loadDevices();
  expect(requestSignal?.aborted).toBe(true);
  expect(() => h.service.getDeviceSpec("device-a")).toThrow(
    new HouseholdError("spec_unavailable"),
  );
  await eventually(() =>
    Object.values(h.runtime.snapshot().projection.device).some(
      (device) => device.spec_status === "error",
    ),
  );
  expect(await oldRead).toBe(false);
  const accepted = Object.values(h.runtime.snapshot().projection.device).find(
    (device) => device.id === "device-a",
  )!;
  expect(accepted).toMatchObject({
    model: replacement.model,
    spec_id: previous.spec_id,
    spec_status: "error",
    spec_error: { code: "mijia_spec_invalid_response" },
    capability_tags: previous.capability_tags,
  });
  expect(
    Object.values(h.runtime.snapshot().projection.device).find(
      (device) => device.id === "stable",
    ),
  ).toMatchObject({
    spec_id: previous.spec_id,
    spec_status: "ready",
    spec_error: null,
  });
  expect(h.runtime.specification("stable").spec).toBe(previousSpec);
  expect(() => h.service.getDeviceSpec("device-a")).toThrow(
    new HouseholdError("spec_unavailable"),
  );
  const requests = h.properties.mock.calls.length;
  await expect(
    h.service.readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "spec_unavailable" });
  expect(h.properties.mock.calls.length).toBe(requests);
  expect(h.service.getDeviceSpec("stable").spec).toBe(previousSpec);
  expect(h.runtime.ready).toBe(true);
});
