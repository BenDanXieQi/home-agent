import { afterEach, expect, test } from "bun:test";
import { MijiaError } from "../../src/mijia/errors";
import {
  createMijiaHousehold,
  createMijiaSpecificationLoader,
} from "../../src/mijia/household";
import { MijiaService } from "../../src/mijia/service";
import { deferred, eventually, nextTurn } from "../support/async";
import {
  householdCatalog,
  runningHousehold,
} from "../support/household-harness";
import { accountClient } from "../support/protocol-fixtures";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
const releases: (() => void)[] = [];
const restarts: ReturnType<typeof createMijiaHousehold>[] = [];
const account = '["cn","100001"]';
const property = { did: "device-a", siid: 2, piid: 1 };
const signal = () => new AbortController().signal;

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const runtime of restarts.splice(0)) await runtime.close();
  for (const household of households.splice(0)) await household.close();
});

// BND-02/03/06: candidates are information, and only one durable selection grants scope.
test("concurrent first choices cannot grant access before persistence or disagree with the saved home", async () => {
  const h = await runningHousehold(householdCatalog(), { homeId: null });
  households.push(h);
  const cloudRequests = h.catalog.mock.calls.length;
  for (let attempt = 0; attempt < 3; attempt++)
    expect(
      h.runtime
        .setupHomes()
        .items.map((home) => home.id)
        .toSorted(),
    ).toEqual(["home-a", "home-b"]);
  expect(h.catalog.mock.calls.length).toBe(cloudRequests);
  expect(h.runtime.ready).toBe(false);
  for (const home of ["", "home-not-in-candidates"])
    await expect(
      h.runtime.bindHome(h.runtime.epoch, home),
    ).rejects.toBeDefined();
  expect(await h.homes.read(account)).toBeUndefined();

  const persist = h.homes.write.getMockImplementation()!;
  const entered = deferred();
  const release = deferred();
  releases.push(() => release.resolve());
  h.homes.write.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    await persist(...args);
  });
  const first = h.runtime.bindHome(h.runtime.epoch, "home-a");
  await entered.promise;
  expect(await h.homes.read(account)).toBeUndefined();
  expect(
    h.runtime.snapshot().projection.household.household.home_id,
  ).toBeNull();
  await expect(
    h.service.readProperties([property], signal()),
  ).rejects.toBeDefined();
  await expect(
    h.service.observeDevices([property.did], () => {}, signal()),
  ).rejects.toBeDefined();
  expect(() =>
    h.runtime.reservePlayback(
      h.runtime.epoch,
      h.service.snapshot().revision,
      property.did,
      1,
    ),
  ).toThrow();

  const second = h.runtime.bindHome(h.runtime.epoch, "home-b");
  const results = Promise.allSettled([first, second]);
  release.resolve();
  const choices = await results;
  const saved = await h.homes.read(account);
  expect(saved).toBeDefined();
  if (!saved?.homeId)
    throw new Error("A successful first selection must be saved");
  expect(["home-a", "home-b"]).toContain(saved.homeId);
  const successfulHomes = choices.flatMap((result, index) =>
    result.status === "fulfilled" ? [["home-a", "home-b"][index]] : [],
  );
  expect(successfulHomes).toEqual([saved.homeId]);
  const currentProperty = {
    ...property,
    did: saved.homeId === "home-a" ? "device-a" : "device-b",
  };
  const foreignProperty = {
    ...property,
    did: saved.homeId === "home-a" ? "device-b" : "device-a",
  };
  await eventually(
    () =>
      h.runtime.ready &&
      Object.values(h.runtime.snapshot().projection.device).some(
        (device) =>
          device.id === currentProperty.did && device.spec_status === "ready",
      ),
  );
  expect(h.runtime.snapshot().projection.household.household.home_id).toBe(
    saved.homeId,
  );
  expect(h.runtime.setupHomes()).toEqual({ items: [] });
  expect(
    await h.service.readProperties([currentProperty], signal()),
  ).toMatchObject([{ status: "success" }]);
  await expect(
    h.service.readProperties([foreignProperty], signal()),
  ).rejects.toMatchObject({ reason: "device_not_found" });
  for (const home of ["home-a", "home-b"])
    await expect(
      h.runtime.bindHome(h.runtime.epoch, home),
    ).rejects.toMatchObject({
      reason: "binding_conflict",
    });
  expect(await h.homes.read(account)).toEqual(saved);
});

// SC-19, BND-01/02/07, RUN-02/09/10: a late acknowledgement cannot revive a stopped run.
test("a binding committed before shutdown survives restart but its late receipt cannot authorize either run", async () => {
  const h = await runningHousehold(householdCatalog(), { homeId: null });
  households.push(h);
  const persist = h.homes.write.getMockImplementation()!;
  const committed = deferred();
  const acknowledge = deferred();
  releases.push(() => acknowledge.resolve());
  h.homes.write.mockImplementationOnce(async (...args) => {
    await persist(...args);
    committed.resolve();
    await acknowledge.promise;
  });
  const oldEpoch = h.runtime.epoch;
  const selection = h.runtime.bindHome(oldEpoch, "home-a").then(
    () => ({ accepted: true as const }),
    (error: unknown) => ({ accepted: false as const, error }),
  );
  await committed.promise;
  expect(await h.homes.read(account)).toEqual({ homeId: "home-a" });
  expect(h.runtime.ready).toBe(false);
  expect(
    h.runtime.snapshot().projection.household.household.home_id,
  ).toBeNull();
  const closing = h.runtime.close();
  expect(h.runtime.ready).toBe(false);
  acknowledge.resolve();
  await closing;
  expect(await selection).toMatchObject({ accepted: false });
  expect(h.runtime.snapshot().projection.household.household.status).toBe(
    "stopping",
  );
  expect(await h.homes.read(account)).toEqual({ homeId: "home-a" });
  expect(await h.store.read("mijia")).toBeDefined();

  const cloudEntered = deferred();
  const cloudReply = deferred<ReturnType<typeof householdCatalog>>();
  releases.push(() => cloudReply.resolve(householdCatalog()));
  h.catalog.mockImplementationOnce(() => {
    cloudEntered.resolve();
    return cloudReply.promise;
  });
  h.renewal.mockResolvedValue(accountClient());
  const service = new MijiaService({
    credentialStore: h.store,
    homeSelectionStore: h.homes,
    readGo2rtcUrl: () => Promise.resolve(h.peer.adapter.url),
  });
  const runtime = createMijiaHousehold(
    service,
    h.repository,
    createMijiaSpecificationLoader(h.specClient),
  );
  restarts.push(runtime);
  runtime.start();
  const initializing = service.initialize();
  await cloudEntered.promise;
  expect(runtime.epoch).not.toBe(oldEpoch);
  expect(runtime.snapshot().projection.household.household).toMatchObject({
    home_id: "home-a",
    status: "initializing",
  });
  expect(runtime.setupHomes()).toEqual({ items: [] });
  await expect(
    service.readProperties([property], signal()),
  ).rejects.toBeDefined();
  await expect(
    service.observeDevices([property.did], () => {}, signal()),
  ).rejects.toBeDefined();
  expect(() => runtime.requestRefresh(oldEpoch, "directory")).toThrow();

  const reordered = householdCatalog();
  reordered.homes.reverse();
  cloudReply.resolve(reordered);
  await initializing;
  await eventually(
    () =>
      runtime.ready &&
      Object.values(runtime.snapshot().projection.device).some(
        (device) =>
          device.id === property.did && device.spec_status === "ready",
      ),
  );
  expect(runtime.snapshot().projection.household.household.home_id).toBe(
    "home-a",
  );
  expect(await h.homes.read(account)).toEqual({ homeId: "home-a" });
  expect(await service.readProperties([property], signal())).toMatchObject([
    { status: "success" },
  ]);
  expect(h.runtime.ready).toBe(false);
});

// SC-14, BND-08, RUN-08/10: failed credential removal does not undo access revocation.
test("failed logout needs a new complete cloud result and never revives old reads, observations or viewers", async () => {
  const catalog = householdCatalog();
  catalog.homes[0]!.deviceIds.push("camera-a");
  catalog.devices.push({
    ...catalog.devices[0]!,
    did: "camera-a",
    model: "test.camera.single",
  });
  const h = await runningHousehold(catalog);
  households.push(h);
  await eventually(() => h.service.snapshot().binding.status === "ready");
  const oldEpoch = h.runtime.epoch;
  const oldRevision = h.service.snapshot().revision;
  const viewer = h.runtime.reservePlayback(
    oldEpoch,
    oldRevision,
    "camera-a",
    1,
  );
  await h.service.offer(oldRevision, viewer.id, "fixture-offer", signal());
  expect(h.service.playbackSnapshot(viewer.id).phase).toBe("active");

  const observed: Parameters<
    Parameters<typeof h.service.observeDevices>[1]
  >[0][] = [];
  await h.service.observeDevices(
    [property.did],
    (event) => observed.push(event),
    signal(),
  );
  const oldTransport = h.mqtt.transports.at(-1)!;
  oldTransport.connected();
  oldTransport.publish(10, property.did);
  expect(observed.filter((event) => event.kind === "property")).toMatchObject([
    { value: 10 },
  ]);
  const readEntered = deferred<AbortSignal | undefined>();
  const lateRead = deferred<Awaited<ReturnType<typeof h.properties>>>();
  releases.push(() => lateRead.resolve([{ ...property, value: 99 }]));
  h.properties.mockImplementationOnce((_batch, requestSignal) => {
    readEntered.resolve(requestSignal);
    return lateRead.promise;
  });
  const oldRead = h.service.readProperties([property], signal()).then(
    (results) => ({ accepted: true as const, results }),
    (error: unknown) => ({ accepted: false as const, error }),
  );
  const readSignal = await readEntered.promise;
  const deletionEntered = deferred();
  const deletion = deferred();
  releases.push(() => deletion.resolve());
  h.store.remove.mockImplementationOnce(async () => {
    deletionEntered.resolve();
    await deletion.promise;
    throw new MijiaError("credential_storage");
  });
  h.catalog.mockRejectedValueOnce(new MijiaError("devices_failed"));
  const logout = h.runtime.logout().then(
    () => ({ accepted: true as const }),
    (error: unknown) => ({ accepted: false as const, error }),
  );
  await deletionEntered.promise;
  expect(h.runtime.ready).toBe(false);
  expect(h.runtime.epoch).not.toBe(oldEpoch);
  expect(readSignal?.aborted).toBe(true);
  expect(await oldRead).toMatchObject({ accepted: false });
  const revokedViewer = await Promise.resolve()
    .then(() => h.service.playbackSnapshot(viewer.id))
    .catch(() => undefined);
  expect(revokedViewer?.phase).not.toBe("active");
  await expect(
    Promise.resolve().then(() =>
      h.service.offer(oldRevision, viewer.id, "fixture-offer", signal()),
    ),
  ).rejects.toBeDefined();
  await expect(
    h.service.readProperties([property], signal()),
  ).rejects.toBeDefined();
  await expect(
    h.service.observeDevices([property.did], () => {}, signal()),
  ).rejects.toBeDefined();
  expect(() =>
    h.runtime.reservePlayback(h.runtime.epoch, oldRevision, "camera-a", 1),
  ).toThrow();

  deletion.resolve();
  expect(await logout).toMatchObject({
    accepted: false,
    error: { reason: "credential_storage" },
  });
  await eventually(
    () =>
      h.runtime.snapshot().projection.household.household.sync_status ===
      "error",
  );
  expect(h.runtime.ready).toBe(false);
  expect(h.service.snapshot().account.status).toBe("authenticated");
  expect(await h.homes.read(account)).toEqual({ homeId: "home-a" });
  expect(await h.store.read("mijia")).toBeDefined();
  await expect(
    h.service.readProperties([property], signal()),
  ).rejects.toBeDefined();

  const retryEntered = deferred();
  const retryReply = deferred<typeof catalog>();
  releases.push(() => retryReply.resolve(catalog));
  h.catalog.mockImplementationOnce(() => {
    retryEntered.resolve();
    return retryReply.promise;
  });
  h.runtime.requestRefresh(h.runtime.epoch, "directory");
  await retryEntered.promise;
  expect(h.runtime.ready).toBe(false);
  retryReply.resolve(catalog);
  await eventually(
    () =>
      h.runtime.ready &&
      Object.values(h.runtime.snapshot().projection.device).some(
        (device) =>
          device.id === property.did && device.spec_status === "ready",
      ),
  );
  lateRead.resolve([{ ...property, value: 99 }]);
  oldTransport.publish(20, property.did);
  await nextTurn();
  expect(observed.filter((event) => event.kind === "property")).toMatchObject([
    { value: 10 },
  ]);
  expect(await oldRead).toMatchObject({ accepted: false });
  expect(() =>
    h.runtime.reservePlayback(oldEpoch, oldRevision, "camera-a", 1),
  ).toThrow();
  expect(await h.service.readProperties([property], signal())).toMatchObject([
    { status: "success", value: 21 },
  ]);
  expect(await h.homes.read(account)).toEqual({ homeId: "home-a" });
  const oldPlayback = await Promise.resolve()
    .then(() =>
      h.service.offer(oldRevision, viewer.id, "fixture-offer", signal()),
    )
    .then(
      (answer) => ({ accepted: true as const, answer }),
      (error: unknown) => ({ accepted: false as const, error }),
    );
  const oldViewer = await Promise.resolve()
    .then(() => h.service.playbackSnapshot(viewer.id))
    .catch(() => undefined);
  expect({
    viewerActive: oldViewer?.phase === "active",
    offerAccepted: oldPlayback.accepted,
  }).toEqual({ viewerActive: false, offerAccepted: false });
  const newRevision = h.service.snapshot().revision;
  const newViewer = h.runtime.reservePlayback(
    h.runtime.epoch,
    newRevision,
    "camera-a",
    1,
  );
  await h.service.offer(newRevision, newViewer.id, "fixture-offer", signal());
  expect(h.service.playbackSnapshot(newViewer.id).phase).toBe("active");
});
