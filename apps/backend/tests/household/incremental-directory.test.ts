import { preparedSpec, specUrn } from "../support/protocol-fixtures";
import { afterEach, expect, test } from "bun:test";
import { entityKey } from "@home-agent/api/household";
import {
  householdCatalog,
  runningHousehold,
} from "../support/household-harness";
import { eventually, nextTurn, deferred } from "../support/async";

const fixtures: Awaited<ReturnType<typeof runningHousehold>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function household(catalog = householdCatalog()) {
  const fixture = await runningHousehold(catalog);
  fixtures.push(fixture);
  await eventually(() =>
    Object.values(fixture.runtime.snapshot().projection.device).every(
      (device) => device.spec_status === "ready",
    ),
  );
  return fixture;
}

test("identical and reordered cloud results preserve records and publish only synchronization metadata", async () => {
  const h = await household();
  const before = h.runtime.snapshot();
  const reads = h.specClient.read.mock.calls.length;
  const changes: ReturnType<typeof h.runtime.changes>[number][] = [];
  const detach = h.runtime.subscribe(() =>
    changes.push(...h.runtime.changes()),
  );
  try {
    const same = structuredClone(householdCatalog());
    same.devices.reverse();
    same.homes.reverse();
    h.catalog.mockResolvedValue(same);
    await h.service.loadDevices();
    const after = h.runtime.snapshot();
    expect(after.projection.home).toBe(before.projection.home);
    expect(after.projection.room).toBe(before.projection.room);
    expect(after.projection.device).toBe(before.projection.device);
    expect(after.scope_epoch).toBe(before.scope_epoch);
    expect(
      changes.some((change) =>
        ["home", "room", "device"].includes(change.entity),
      ),
    ).toBe(false);
    expect(h.specClient.read.mock.calls.length).toBe(reads);
  } finally {
    detach();
  }
});

test("renaming one device publishes only that device and preserves peer records and specifications", async () => {
  const h = await household();
  const before = h.runtime.snapshot();
  const reads = h.specClient.read.mock.calls.length;
  const changes: ReturnType<typeof h.runtime.changes>[number][] = [];
  const detach = h.runtime.subscribe(() =>
    changes.push(...h.runtime.changes()),
  );
  try {
    const next = {
      ...householdCatalog(),
      devices: householdCatalog().devices.map((device) =>
        device.did === "device-a" ? { ...device, name: "Renamed" } : device,
      ),
    };
    h.catalog.mockResolvedValue(next);
    await h.service.loadDevices();
    const after = h.runtime.snapshot();
    const account = h.service.identity()!;
    expect(after.projection.device[entityKey(account, "stable")]).toBe(
      before.projection.device[entityKey(account, "stable")],
    );
    expect(after.projection.device[entityKey(account, "device-a")]?.name).toBe(
      "Renamed",
    );
    expect(
      changes
        .filter((change) => change.entity === "device")
        .map((change) => [change.op, change.key]),
    ).toEqual([["upsert", entityKey(account, "device-a")]]);
    expect(h.specClient.read.mock.calls.length).toBe(reads);
  } finally {
    detach();
  }
});

test("removal and reappearance publish only the affected device without rebinding the household", async () => {
  const h = await household();
  const before = h.runtime.snapshot();
  const account = h.service.identity()!;
  const peer = before.projection.device[entityKey(account, "stable")];
  const changes: ReturnType<typeof h.runtime.changes>[number][] = [];
  const detach = h.runtime.subscribe(() =>
    changes.push(...h.runtime.changes()),
  );
  try {
    const next = householdCatalog();
    next.devices = next.devices.filter((device) => device.did !== "device-a");
    h.catalog.mockResolvedValue(next);
    await h.service.loadDevices();
    expect(
      changes
        .filter((change) => change.entity === "device")
        .map((change) => [change.op, change.key]),
    ).toEqual([["remove", entityKey(account, "device-a")]]);
    changes.length = 0;
    h.catalog.mockResolvedValue(householdCatalog());
    await h.service.loadDevices();
    await eventually(
      () =>
        h.runtime.snapshot().projection.device[entityKey(account, "device-a")]
          ?.spec_status === "ready",
    );
    expect(
      h.runtime.snapshot().projection.device[entityKey(account, "stable")],
    ).toBe(peer);
    expect(
      changes
        .filter((change) => change.entity === "device")
        .every(
          (change) =>
            change.op === "upsert" &&
            change.key === entityKey(account, "device-a"),
        ),
    ).toBe(true);
    expect(h.runtime.epoch).toBe(before.scope_epoch);
    expect(h.homes.write).not.toHaveBeenCalled();
  } finally {
    detach();
  }
});

test("unchanged camera definitions are not reinstalled and a local address change touches only its source", async () => {
  const catalog = householdCatalog();
  catalog.devices = catalog.devices.map((device) => ({
    ...device,
    model: "test.camera.single",
  }));
  const h = await household(catalog);
  const cameraWrites = () =>
    h.peer.calls.filter(
      (call) => call.path === "camera" && call.method === "PUT",
    );
  await eventually(
    () =>
      h.service.snapshot().binding.status === "ready" &&
      cameraWrites().length === 2,
  );
  await nextTurn();
  const renamed = {
    ...catalog,
    devices: catalog.devices.map((device) => ({
      ...device,
      name: "Renamed camera",
    })),
  };
  h.catalog.mockResolvedValue(renamed);
  await h.service.loadDevices();
  await nextTurn();
  expect(cameraWrites()).toHaveLength(2);
  h.catalog.mockResolvedValue({
    ...renamed,
    devices: renamed.devices.map((device) =>
      device.did === "device-a" ? { ...device, localip: "192.0.2.20" } : device,
    ),
  });
  await h.service.loadDevices();
  await eventually(() => cameraWrites().length === 3);
  expect(
    h.peer.calls.filter(
      (call) => call.path === "camera" && call.method === "DELETE",
    ),
  ).toHaveLength(1);
});

test("a specification finishing during a directory save is not overwritten by its older candidate", async () => {
  const h = await household();
  const { category, spec } = preparedSpec();
  const metadata = { urn: specUrn, category, spec };
  const read = deferred<typeof metadata>();
  const readStarted = deferred();
  h.specClient.read.mockImplementationOnce(() => {
    readStarted.resolve();
    return read.promise;
  });
  h.runtime.requestRefresh(h.runtime.epoch, "specs");
  await readStarted.promise;
  const save = deferred<string>();
  const saving = deferred();
  h.repository.save.mockImplementationOnce(() => {
    saving.resolve();
    return save.promise;
  });
  h.catalog.mockResolvedValue({
    ...householdCatalog(),
    devices: householdCatalog().devices.map((device) =>
      device.did === "device-a" ? { ...device, name: "New name" } : device,
    ),
  });
  const refresh = h.service.loadDevices();
  await saving.promise;
  read.resolve({ ...metadata, category: "updated" });
  await eventually(() =>
    Object.values(h.runtime.snapshot().projection.device).every(
      (device) =>
        device.spec_status === "ready" && device.category === "updated",
    ),
  );
  const peer =
    h.runtime.snapshot().projection.device[
      entityKey(h.service.identity()!, "stable")
    ];
  save.resolve(new Date().toISOString());
  await refresh;
  expect(
    Object.values(h.runtime.snapshot().projection.device).every(
      (device) =>
        device.spec_status === "ready" && device.category === "updated",
    ),
  ).toBe(true);
  expect(
    h.runtime.snapshot().projection.device[
      entityKey(h.service.identity()!, "stable")
    ],
  ).toBe(peer);
});
