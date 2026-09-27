import { afterEach, describe, expect, test } from "bun:test";
import { MiCloudError } from "../../../src/mijia/protocols/micloud";
import type { MiotObservation } from "../../../src/mijia/protocols/miot/messages";
import { deferred, eventually, nextTurn } from "../../support/async";
import {
  householdCatalog,
  runningHousehold,
} from "../../support/household-harness";
import { preparedSpec, specUrn } from "../../support/protocol-fixtures";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const household of households.splice(0)) await household.close();
});

function device(
  household: Awaited<ReturnType<typeof runningHousehold>>,
  id: string,
) {
  return Object.values(household.runtime.snapshot().projection.device).find(
    (item) => item.id === id,
  );
}

function read(
  household: Awaited<ReturnType<typeof runningHousehold>>,
  did: string,
  piid = 1,
) {
  return household.service.readProperties(
    [{ did, siid: 2, piid }],
    new AbortController().signal,
  );
}

describe("household specification business behavior", () => {
  test("SC-10/SC-20: restoring inventory storage does not authorize a changed URN or clear its specification failure", async () => {
    const h = await runningHousehold();
    households.push(h);
    const before = h.runtime.snapshot();
    const originalModel = device(h, "device-a")!.model;
    const nextUrn = specUrn.replace(/:1$/, ":2");
    const catalog = householdCatalog();
    catalog.devices.find((item) => item.did === "device-a")!.spec_type =
      nextUrn;
    h.specClient.resolve.mockImplementation((item, signal) =>
      Promise.resolve({
        urn: item.spec_type ?? specUrn,
        requestSignal: signal,
      }),
    );
    h.specClient.read.mockRejectedValue(
      new MiCloudError("spec-invalid-response"),
    );
    h.repository.save.mockRejectedValue(new Error("Inventory storage offline"));
    h.catalog.mockResolvedValue(catalog);

    await h.service.loadDevices();
    await eventually(() => device(h, "device-a")?.spec_status === "error");
    const failed = h.runtime.snapshot().projection;
    const specificationError = device(h, "device-a")!.spec_error;
    expect(specificationError).not.toBeNull();
    expect(device(h, "device-a")?.model).toBe(originalModel);
    expect(failed.household.household).toMatchObject({
      status: "running",
      home_id: "home-a",
      saved_at: before.projection.household.household.saved_at,
    });
    expect(failed.projection_health.projection_health.storage_degraded).toBe(
      true,
    );
    await expect(read(h, "device-a")).rejects.toBeDefined();
    expect(await read(h, "stable")).toMatchObject([
      { did: "stable", status: "success", value: 21 },
    ]);

    const savedAt = new Date(
      Date.parse(before.projection.household.household.saved_at!) + 1_000,
    ).toISOString();
    h.repository.save.mockImplementation(
      (_account, _home, _directory, assertCurrent) => {
        assertCurrent();
        return Promise.resolve(savedAt);
      },
    );
    await h.service.loadDevices();

    const recovered = h.runtime.snapshot().projection;
    expect(recovered.projection_health.projection_health.storage_degraded).toBe(
      false,
    );
    expect(recovered.household.household).toMatchObject({
      status: "running",
      home_id: "home-a",
      saved_at: savedAt,
    });
    expect(device(h, "device-a")).toMatchObject({
      spec_status: "error",
      spec_error: specificationError,
    });
    expect(device(h, "stable")).toMatchObject({
      spec_status: "ready",
      spec_error: null,
    });
    await expect(read(h, "device-a")).rejects.toBeDefined();
    expect(await read(h, "stable")).toMatchObject([
      { did: "stable", status: "success", value: 21 },
    ]);
    expect(h.runtime.epoch).toBe(before.scope_epoch);
  });

  test("DIR-05/DIR-13: a model change revokes old work even when its current URN can reuse confirmed capabilities", async () => {
    const h = await runningHousehold();
    households.push(h);
    const transport = h.mqtt.transports[0]!;
    transport.connected();
    for (let index = 0; index < transport.subscriptions.length; index++)
      transport.ack(index);
    const observations: MiotObservation[] = [];
    await h.service.observeDevices(
      ["device-a", "stable"],
      (event) => observations.push(event),
      new AbortController().signal,
    );
    for (let index = 0; index < transport.subscriptions.length; index++)
      transport.ack(index);

    const started = deferred();
    const response = deferred<Awaited<ReturnType<typeof h.properties>>>();
    h.properties.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const release = () =>
      response.resolve([{ did: "device-a", siid: 2, piid: 1, value: 99 }]);
    releases.push(release);
    const oldRead = read(h, "device-a").then(
      () => "delivered" as const,
      () => "revoked" as const,
    );
    await started.promise;
    const catalog = householdCatalog();
    catalog.devices.find((item) => item.did === "device-a")!.model =
      "test.sensor.replacement";
    h.catalog.mockResolvedValue(catalog);
    await h.service.loadDevices();
    release();
    expect(await oldRead).toBe("revoked");

    transport.publish(99, "device-a");
    transport.publish(22, "stable");
    await nextTurn();
    expect(
      observations.filter((event) => event.kind === "property"),
    ).toMatchObject([{ did: "stable", value: 22 }]);
    expect(device(h, "device-a")).toMatchObject({
      model: "test.sensor.replacement",
      spec_status: "ready",
      spec_error: null,
    });
    expect(await read(h, "device-a")).toMatchObject([
      { did: "device-a", status: "success", value: 21 },
    ]);
    expect(await read(h, "stable")).toMatchObject([
      { did: "stable", status: "success", value: 21 },
    ]);
  });

  test("SPC-04/SPC-08: a failed refresh preserves applicable reads without making write-only properties readable", async () => {
    const h = await runningHousehold();
    households.push(h);
    for (const id of ["device-a", "stable"])
      expect(device(h, id)?.capability_tags).toEqual(
        expect.arrayContaining(["readable", "writeable", "notify"]),
      );
    h.specClient.read.mockRejectedValue(
      new MiCloudError("spec-invalid-response"),
    );
    h.runtime.requestRefresh(h.runtime.epoch, "specs");
    await eventually(() =>
      ["device-a", "stable"].every(
        (id) => device(h, id)?.spec_status === "error",
      ),
    );

    expect(h.runtime.snapshot().projection.household.household.status).toBe(
      "running",
    );
    for (const id of ["device-a", "stable"]) {
      expect(device(h, id)?.spec_error).not.toBeNull();
      expect(await read(h, id)).toMatchObject([
        { did: id, status: "success", value: 21 },
      ]);
      await expect(read(h, id, 3)).rejects.toBeDefined();
    }
  });

  test("DIR-13/SC-11: shared devices remain usable through reference changes and the last removal cancels an obsolete refresh", async () => {
    const h = await runningHousehold();
    households.push(h);
    const catalog = householdCatalog();
    const changed = {
      homes: catalog.homes.map((home) => ({
        ...home,
        deviceIds: home.id === "home-a" ? ["stable", "new-device"] : [],
      })),
      devices: [
        catalog.devices.find((item) => item.did === "stable")!,
        { ...catalog.devices[0]!, did: "new-device" },
      ],
    };
    const peerStates: ReturnType<typeof device>[] = [];
    const unsubscribe = h.runtime.subscribe(() =>
      peerStates.push(device(h, "stable")),
    );
    releases.push(unsubscribe);
    h.specClient.read.mockClear();
    h.catalog.mockResolvedValue(changed);
    await h.service.loadDevices();
    await eventually(() => device(h, "new-device")?.spec_status === "ready");
    unsubscribe();

    expect(peerStates.length).toBeGreaterThan(0);
    expect(peerStates.every((item) => item?.spec_status === "ready")).toBe(
      true,
    );
    expect(h.specClient.read).not.toHaveBeenCalled();
    for (const id of ["stable", "new-device"])
      expect(await read(h, id)).toMatchObject([
        { did: id, status: "success", value: 21 },
      ]);
    await expect(read(h, "device-a")).rejects.toBeDefined();

    const started = deferred<AbortSignal>();
    const response = deferred<Awaited<ReturnType<typeof h.specClient.read>>>();
    h.specClient.read.mockImplementation((_resolved, signal) => {
      started.resolve(signal);
      return response.promise;
    });
    const release = () => {
      const { category, spec } = preparedSpec();
      response.resolve({ urn: specUrn, category, spec });
    };
    releases.push(release);
    h.runtime.requestRefresh(h.runtime.epoch, "specs");
    const signal = await started.promise;
    h.catalog.mockResolvedValue({
      homes: changed.homes.map((home) => ({ ...home, deviceIds: [] })),
      devices: [],
    });
    await h.service.loadDevices();
    expect(signal.aborted).toBe(true);
    release();
    await nextTurn();

    const projection = h.runtime.snapshot().projection;
    expect(projection.household.household).toMatchObject({
      status: "running",
      home_id: "home-a",
    });
    expect(Object.values(projection.device)).toEqual([]);
    for (const id of ["stable", "new-device"])
      await expect(read(h, id)).rejects.toBeDefined();
  });
});
