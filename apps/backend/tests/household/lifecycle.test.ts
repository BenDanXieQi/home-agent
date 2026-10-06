import { afterEach, expect, spyOn, test } from "bun:test";
import {
  householdCatalog,
  runningHousehold,
  loginHttp,
} from "../support/household-harness";
import { deferred, eventually } from "../support/async";
import { MijiaError } from "../../src/mijia/errors";

const fixtures: Awaited<ReturnType<typeof runningHousehold>>[] = [];
const restore: (() => void)[] = [];
afterEach(async () => {
  for (const reset of restore.splice(0).toReversed()) reset();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

test("logout retains the fixed binding and the original account can log in again", async () => {
  const fixture = await runningHousehold();
  fixtures.push(fixture);
  await fixture.runtime.logout();
  expect(
    fixture.runtime.snapshot().projection.household.household,
  ).toMatchObject({
    account_id: '["cn","100001"]',
    home_id: "home-a",
    status: "unbound",
  });
  const login = loginHttp(fixture, { userId: "100001" });
  restore.push(login.restore);
  fixture.service.startLogin();
  await eventually(() => fixture.runtime.ready);
  expect(
    fixture.runtime.snapshot().projection.household.household.home_id,
  ).toBe("home-a");
});

test("failed logout refreshes the same account and restores reads in the new scope", async () => {
  const fixture = await runningHousehold();
  fixtures.push(fixture);
  const epoch = fixture.runtime.epoch;
  const requests = fixture.catalog.mock.calls.length;
  fixture.store.remove.mockRejectedValueOnce(
    new MijiaError("credential_storage"),
  );

  await expect(fixture.runtime.logout()).rejects.toMatchObject({
    reason: "credential_storage",
  });
  await eventually(
    () =>
      fixture.runtime.ready &&
      Object.values(fixture.runtime.snapshot().projection.device).some(
        (device) => device.id === "device-a" && device.spec_status === "ready",
      ),
  );

  expect(fixture.catalog.mock.calls.length).toBeGreaterThan(requests);
  expect(fixture.service.snapshot().account.status).toBe("authenticated");
  expect(fixture.runtime.epoch).not.toBe(epoch);
  expect(() => fixture.runtime.requestRefresh(epoch, "directory")).toThrow();
  expect(
    await fixture.service.readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).toMatchObject([{ status: "success" }]);
});

test("failed logout restores only devices returned by a successful cloud refresh", async () => {
  const fixture = await runningHousehold();
  fixtures.push(fixture);
  const catalog = householdCatalog();
  catalog.devices = catalog.devices.filter(
    (device) => device.did !== "device-a",
  );
  fixture.catalog.mockResolvedValue(catalog);
  fixture.store.remove.mockRejectedValueOnce(
    new MijiaError("credential_storage"),
  );

  await expect(fixture.runtime.logout()).rejects.toMatchObject({
    reason: "credential_storage",
  });
  await eventually(() => fixture.runtime.ready);

  expect(fixture.runtime.ready).toBe(true);
  expect(
    Object.values(fixture.runtime.snapshot().projection.device).map(
      (device) => device.id,
    ),
  ).toEqual(["stable"]);
  await expect(
    fixture.service.readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "device_not_found" });
});

test("a throwing subscriber cannot prevent first binding or later subscribers", async () => {
  const fixture = await runningHousehold(householdCatalog(), { homeId: null });
  fixtures.push(fixture);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  restore.push(() => warning.mockRestore());
  let observed = 0;
  restore.push(
    fixture.runtime.subscribe(() => {
      throw new Error("subscriber failure");
    }),
    fixture.runtime.subscribe(() => {
      observed++;
    }),
  );
  await fixture.runtime.bindHome(fixture.runtime.epoch, "home-b");
  await eventually(() => fixture.runtime.ready);
  expect(await fixture.homes.read(fixture.service.identity()!)).toEqual({
    homeId: "home-b",
  });
  expect(observed).toBeGreaterThan(0);
  expect(warning).toHaveBeenCalled();
});

test("home access loss keeps the saved binding without choosing another home", async () => {
  const fixture = await runningHousehold();
  fixtures.push(fixture);
  const epoch = fixture.runtime.epoch;
  fixture.runtime.revoke(
    {
      ...fixture.service.directorySnapshot()!,
      homes: [
        { id: "home-b", name: "x".repeat(2_200_000), shared: false, rooms: [] },
      ],
      devices: [],
    },
    () => {},
  );
  const snapshot = fixture.runtime.snapshot();
  expect(snapshot.scope_epoch).not.toBe(epoch);
  expect(snapshot.projection.household.household).toMatchObject({
    status: "initializing",
    home_id: "home-a",
    homes: { status: "unavailable" },
  });
  expect(snapshot.projection.device).toEqual({});
  expect(fixture.runtime.ready).toBe(false);
  expect(fixture.homes.write).not.toHaveBeenCalled();
  expect(await fixture.homes.read(fixture.service.identity()!)).toEqual({
    homeId: "home-a",
  });
  await expect(
    fixture.service.readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "devices_failed" });
});

test("switching homes waits for durable binding before replacing device access", async () => {
  const saveEntered = deferred();
  const saveAllowed = deferred();
  restore.push(() => saveAllowed.resolve());
  const fixture = await runningHousehold(householdCatalog(), {
    homeId: "home-a",
  });
  fixtures.push(fixture);
  const before = fixture.runtime.snapshot();
  const persist = fixture.homes.write.getMockImplementation()!;
  fixture.homes.write.mockImplementationOnce(async (...args) => {
    saveEntered.resolve();
    await saveAllowed.promise;
    await persist(...args);
  });
  await expect(
    fixture.runtime.bindHome(before.scope_epoch, "home-a"),
  ).rejects.toMatchObject({ reason: "binding_conflict" });
  const switching = fixture.runtime.bindHome(before.scope_epoch, "home-b");
  await saveEntered.promise;
  expect(fixture.runtime.epoch).toBe(before.scope_epoch);
  expect(fixture.runtime.ready).toBe(true);
  expect(await fixture.homes.read(fixture.service.identity()!)).toEqual({
    homeId: "home-a",
  });
  expect(
    await fixture.service.readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).toMatchObject([{ status: "success" }]);
  saveAllowed.resolve();
  const receipt = await switching;

  expect(receipt.state_version.scope_epoch).not.toBe(before.scope_epoch);
  expect(fixture.runtime.epoch).toBe(receipt.state_version.scope_epoch);
  expect(await fixture.homes.read(fixture.service.identity()!)).toEqual({
    homeId: "home-b",
  });
  await expect(
    fixture.runtime.bindHome(before.scope_epoch, "home-a"),
  ).rejects.toMatchObject({ reason: "stale_session" });
  await eventually(
    () =>
      fixture.runtime.ready &&
      Object.values(fixture.runtime.snapshot().projection.device).some(
        (device) => device.id === "device-b" && device.spec_status === "ready",
      ),
  );
  expect(
    Object.values(fixture.runtime.snapshot().projection.device).map(
      (device) => device.id,
    ),
  ).toEqual(["device-b"]);
  await expect(
    fixture.service.readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "device_not_found" });
  expect(
    await fixture.service.readProperties(
      [{ did: "device-b", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).toMatchObject([{ status: "success" }]);
});

test("first directory cache failure does not block confirmed device access", async () => {
  const fixture = await runningHousehold(householdCatalog(), {
    homeId: "home-a",
    saveError: new MijiaError("home_storage"),
  });
  fixtures.push(fixture);
  expect(fixture.runtime.ready).toBe(true);
  expect(
    fixture.runtime.snapshot().projection.projection_health.projection_health
      .storage_degraded,
  ).toBe(true);
  expect(
    fixture.runtime.snapshot().projection.household.household.saved_at,
  ).toBeNull();
  expect(
    await fixture.service.readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).toMatchObject([{ status: "success" }]);
  fixture.repository.save.mockImplementation(async () =>
    new Date().toISOString(),
  );
  await fixture.service.loadDevices();
  expect(
    fixture.runtime.snapshot().projection.projection_health.projection_health
      .storage_degraded,
  ).toBe(false);
  expect(
    fixture.runtime.snapshot().projection.household.household.saved_at,
  ).not.toBeNull();
});

test("first binding returns a committed version after durable persistence", async () => {
  const fixture = await runningHousehold(householdCatalog(), { homeId: null });
  fixtures.push(fixture);
  const epoch = fixture.runtime.epoch;
  const result = await fixture.runtime.bindHome(epoch, "home-b");
  expect(result.state_version.scope_epoch).toBe(epoch);
  expect(fixture.runtime.snapshot().sequence).toBeGreaterThanOrEqual(
    result.state_version.sequence,
  );
  expect(await fixture.homes.read(fixture.service.identity()!)).toEqual({
    homeId: "home-b",
  });
  await eventually(() => fixture.runtime.ready);
});

test("first binding rechecks membership after a queued cloud refresh", async () => {
  const fixture = await runningHousehold(householdCatalog(), { homeId: null });
  fixtures.push(fixture);
  const catalog = householdCatalog();
  catalog.homes = catalog.homes.filter((home) => home.id !== "home-b");
  catalog.devices = catalog.devices.filter(
    (device) => device.home_id !== "home-b",
  );
  fixture.catalog.mockResolvedValue(catalog);
  const binding = deferred<PromiseSettledResult<unknown>>();
  const flush = fixture.service.flushChanges.bind(fixture.service);
  const duringCommit = spyOn(
    fixture.service,
    "flushChanges",
  ).mockImplementationOnce(() => {
    expect(
      fixture.service.homes().items.some((home) => home.id === "home-b"),
    ).toBe(true);
    fixture.runtime.bindHome(fixture.runtime.epoch, "home-b").then(
      (value) => binding.resolve({ status: "fulfilled", value }),
      (reason: unknown) => binding.resolve({ status: "rejected", reason }),
    );
    flush();
  });
  restore.push(() => duringCommit.mockRestore());

  await fixture.service.loadDevices();
  expect(await binding.promise).toMatchObject({
    status: "rejected",
    reason: { reason: "home_unavailable" },
  });
  expect(fixture.homes.write).not.toHaveBeenCalled();
  expect(
    fixture.runtime.snapshot().projection.household.household.home_id,
  ).toBeNull();

  await fixture.runtime.bindHome(fixture.runtime.epoch, "home-a");
  await eventually(() => fixture.runtime.ready);
  expect(await fixture.homes.read(fixture.service.identity()!)).toEqual({
    homeId: "home-a",
  });
});

test("an oversized initial directory leaves the durable binding unavailable until refresh", async () => {
  const fixture = await runningHousehold(householdCatalog(), { homeId: null });
  fixtures.push(fixture);
  const catalog = householdCatalog();
  const oversized = Array.from({ length: 1200 }, (_, index) => ({
    ...catalog.devices[2]!,
    did: `oversized-${index}`,
  }));
  catalog.homes[1]!.deviceIds = oversized.map((device) => device.did);
  fixture.catalog.mockResolvedValue({
    ...catalog,
    devices: [catalog.devices[0]!, catalog.devices[1]!, ...oversized],
  });
  await fixture.runtime.bindHome(fixture.runtime.epoch, "home-b");
  await eventually(
    () =>
      fixture.runtime.snapshot().projection.household.household.error?.code ===
      "mijia_capacity_exceeded",
  );
  expect(fixture.runtime.ready).toBe(false);
  expect(
    fixture.runtime.snapshot().projection.household.household.home_id,
  ).toBe("home-b");
  expect(await fixture.homes.read(fixture.service.identity()!)).toEqual({
    homeId: "home-b",
  });
});

test("a failed initial binding save leaves setup available and can be retried", async () => {
  const fixture = await runningHousehold(householdCatalog(), { homeId: null });
  fixtures.push(fixture);
  const epoch = fixture.runtime.epoch;
  fixture.homes.write.mockRejectedValueOnce(new MijiaError("home_storage"));
  await expect(fixture.runtime.bindHome(epoch, "home-b")).rejects.toMatchObject(
    { reason: "home_storage" },
  );
  expect(
    fixture.runtime.snapshot().projection.household.household.home_id,
  ).toBeNull();
  await fixture.runtime.bindHome(epoch, "home-b");
  await eventually(() => fixture.runtime.ready);
  expect(fixture.runtime.epoch).toBe(epoch);
});

test("a failed initial directory retries without rewriting the binding", async () => {
  const fixture = await runningHousehold(householdCatalog(), { homeId: null });
  fixtures.push(fixture);
  fixture.catalog.mockRejectedValueOnce(new MijiaError("devices_failed"));
  const selected = await fixture.runtime.bindHome(
    fixture.runtime.epoch,
    "home-b",
  );
  await eventually(
    () =>
      fixture.runtime.snapshot().projection.household.household.error?.code ===
      "mijia_devices_failed",
  );
  const writes = fixture.homes.write.mock.calls.length;
  fixture.runtime.requestRefresh(fixture.runtime.epoch, "directory");
  await eventually(() => fixture.runtime.ready);
  expect(fixture.homes.write.mock.calls.length).toBe(writes);
  expect(fixture.runtime.epoch).toBe(selected.state_version.scope_epoch);
});

test("logout supersedes an in-flight first binding without accepting late results", async () => {
  const fixture = await runningHousehold(householdCatalog(), { homeId: null });
  fixtures.push(fixture);
  const entered = deferred();
  const release = deferred();
  restore.push(() => release.resolve());
  fixture.homes.write.mockImplementationOnce(
    async (_account, _home, assert) => {
      entered.resolve();
      await release.promise;
      assert();
    },
  );
  const selection = fixture.runtime
    .bindHome(fixture.runtime.epoch, "home-b")
    .catch((error: unknown) => error);
  await entered.promise;
  const logout = fixture.runtime.logout();
  release.resolve();
  await logout;
  expect(await selection).toMatchObject({ reason: "stale_session" });
  expect(fixture.runtime.ready).toBe(false);
  expect(
    fixture.runtime.snapshot().projection.household.household.home_id,
  ).toBeNull();
});

test("a running household refresh does not wait for media initialization", async () => {
  const fixture = await runningHousehold(householdCatalog(), { homeId: null });
  fixtures.push(fixture);
  const entered = deferred();
  const release = deferred();
  restore.push(() => release.resolve());
  fixture.peer.handlers.set("PUT session", async () => {
    entered.resolve();
    await release.promise;
    return new Response(null, { status: 204 });
  });
  const selection = await fixture.runtime.bindHome(
    fixture.runtime.epoch,
    "home-b",
  );
  await entered.promise;
  expect(fixture.runtime.ready).toBe(true);
  const requests = fixture.catalog.mock.calls.length;
  fixture.runtime.requestRefresh(fixture.runtime.epoch, "directory");
  await eventually(() => fixture.catalog.mock.calls.length > requests);
  expect(fixture.runtime.epoch).toBe(selection.state_version.scope_epoch);
  release.resolve();
});

test("missing details in an unrelated home do not block account restoration or bound-home reads", async () => {
  const catalog = householdCatalog();
  catalog.devices = catalog.devices.filter(
    (device) => device.home_id === "home-a",
  );
  const fixture = await runningHousehold(catalog);
  fixtures.push(fixture);
  expect(fixture.service.snapshot().account.status).toBe("authenticated");
  expect(fixture.runtime.ready).toBe(true);
  expect(
    await fixture.service.readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).toMatchObject([{ status: "success" }]);
});

test("successful refresh without details removes the device and accepts it again when details return", async () => {
  const fixture = await runningHousehold();
  fixtures.push(fixture);
  const catalog = householdCatalog();
  catalog.devices = catalog.devices.filter(
    (device) => device.did !== "device-a",
  );
  fixture.catalog.mockResolvedValue(catalog);
  await fixture.service.loadDevices();
  expect(fixture.runtime.ready).toBe(true);
  expect(
    Object.values(fixture.runtime.snapshot().projection.device).map(
      (device) => device.id,
    ),
  ).toEqual(["stable"]);
  expect(fixture.service.snapshot().devices.status).toBe("ready");
  await expect(
    fixture.service.readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "device_not_found" });
  fixture.catalog.mockResolvedValue(householdCatalog());
  await fixture.service.loadDevices();
  await eventually(() =>
    Object.values(fixture.runtime.snapshot().projection.device).some(
      (device) => device.id === "device-a" && device.spec_status === "ready",
    ),
  );
  expect(
    await fixture.service.readProperties(
      [{ did: "device-a", siid: 2, piid: 1 }],
      new AbortController().signal,
    ),
  ).toMatchObject([{ status: "success" }]);
});

test("first binding permits an empty accessible device list and later discovers returned devices", async () => {
  const fixture = await runningHousehold(householdCatalog(), { homeId: null });
  fixtures.push(fixture);
  const catalog = householdCatalog();
  catalog.devices = catalog.devices.filter(
    (device) => device.home_id !== "home-b",
  );
  fixture.catalog.mockResolvedValue(catalog);
  await fixture.runtime.bindHome(fixture.runtime.epoch, "home-b");
  await eventually(() => fixture.runtime.ready);
  expect(fixture.runtime.snapshot().projection.device).toEqual({});
  expect(fixture.service.snapshot().account.status).toBe("authenticated");
  expect(await fixture.homes.read(fixture.service.identity()!)).toEqual({
    homeId: "home-b",
  });
  const writes = fixture.homes.write.mock.calls.length;
  fixture.catalog.mockResolvedValue(householdCatalog());
  await fixture.service.loadDevices();
  expect(fixture.runtime.ready).toBe(true);
  expect(fixture.homes.write.mock.calls.length).toBe(writes);
});

test("a sole home runs with returned device details and later expands its accessible list", async () => {
  const original = householdCatalog();
  const catalog = {
    homes: [original.homes[0]!],
    devices: original.devices.filter((device) => device.did === "stable"),
  };
  const fixture = await runningHousehold(catalog, {
    homeId: null,
    automaticBinding: true,
  });
  fixtures.push(fixture);
  expect(fixture.runtime.ready).toBe(true);
  expect(fixture.service.snapshot().account.status).toBe("authenticated");
  expect(await fixture.homes.read(fixture.service.identity()!)).toEqual({
    homeId: "home-a",
  });
  const writes = fixture.homes.write.mock.calls.length;
  fixture.catalog.mockResolvedValue({
    ...catalog,
    devices: original.devices.filter((device) => device.home_id === "home-a"),
  });
  await fixture.service.loadDevices();
  expect(fixture.runtime.ready).toBe(true);
  expect(fixture.homes.write.mock.calls.length).toBe(writes);
});

test("a queued refresh does not start cloud work after the runtime is stopped", async () => {
  const fixture = await runningHousehold();
  fixtures.push(fixture);
  const requests = fixture.catalog.mock.calls.length;
  fixture.runtime.requestRefresh(fixture.runtime.epoch, "directory");
  await fixture.runtime.close();
  expect(fixture.catalog.mock.calls.length).toBe(requests);
  expect(fixture.runtime.ready).toBe(false);
});

test("device snapshots remain detached when discovery reuses its prepared display records", async () => {
  const fixture = await runningHousehold();
  fixtures.push(fixture);
  const before = fixture.service.snapshot();
  const exposed = fixture.service.snapshot();
  exposed.devices.items[0]!.name = "Changed by consumer";
  exposed.devices.items[0]!.channels.push(1);
  expect(fixture.service.snapshot().devices).toEqual(before.devices);
});
