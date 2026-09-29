import { afterEach, expect, test } from "bun:test";
import { createHouseholdRoutes } from "../../src/household/routes";
import {
  snapshotSchema,
  stateChangeSchema,
  commandResultSchema,
} from "@home-agent/api/household";
import {
  householdCatalog,
  runningHousehold,
} from "../support/household-harness";
import { deferred, eventually, nextTurn } from "../support/async";
import { preparedSpec, specUrn } from "../support/protocol-fixtures";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const fixture of households.splice(0)) await fixture.close();
});

async function household(
  catalog: Parameters<typeof runningHousehold>[0] = householdCatalog(),
) {
  const h = await runningHousehold(catalog);
  households.push(h);
  await eventually(() =>
    Object.values(h.runtime.snapshot().projection.device).every(
      (device) => device.spec_status === "ready",
    ),
  );
  return h;
}

function read(h: Awaited<ReturnType<typeof household>>, did: string) {
  return h.service.readProperties(
    [{ did, siid: 2, piid: 1 }],
    new AbortController().signal,
  );
}

// DIR-04/09, RUN-10, SC-09: admission failure cannot undo an authoritative removal.
test.each(["device count", "UTF-8 bytes"] as const)(
  "%s overflow rejects additions but revokes the removed device and its late read",
  async (limit) => {
    const h = await household();
    const binding = await h.homes.read(h.service.identity()!);
    const started = deferred<AbortSignal | undefined>();
    const late = deferred<Awaited<ReturnType<typeof h.properties>>>();
    h.properties.mockImplementationOnce((_batch, signal) => {
      started.resolve(signal);
      return late.promise;
    });
    const release = () =>
      late.resolve([{ did: "device-a", siid: 2, piid: 1, value: 999 }]);
    releases.push(release);
    const oldRead = read(h, "device-a").then(
      () => "delivered",
      () => "rejected",
    );
    const signal = await started.promise;
    const catalog = householdCatalog();
    catalog.devices = catalog.devices.filter(
      (device) => device.did !== "device-a",
    );
    const additions = Array.from(
      { length: limit === "device count" ? 1024 : 1 },
      (_, index) => ({
        ...catalog.devices[0]!,
        did: `new-${index}`,
        name: limit === "UTF-8 bytes" ? "温".repeat(1_400_000) : "New sensor",
      }),
    );
    catalog.devices.push(...additions);
    catalog.homes[0]!.deviceIds = [
      "stable",
      ...additions.map((device) => device.did),
    ];
    // This byte-overflow input is below 4 MiB in characters, above it in UTF-8.
    if (limit === "UTF-8 bytes") {
      expect(JSON.stringify(catalog).length).toBeLessThan(4 * 1024 * 1024);
      expect(Buffer.byteLength(JSON.stringify(catalog))).toBeGreaterThan(
        4 * 1024 * 1024,
      );
    }
    h.catalog.mockResolvedValue(catalog);
    await h.service.loadDevices();
    expect(signal?.aborted).toBe(true);
    release();
    expect(await oldRead).toBe("rejected");
    await expect(read(h, "device-a")).rejects.toBeDefined();
    await expect(read(h, "new-0")).rejects.toBeDefined();
    expect(await read(h, "stable")).toMatchObject([
      { did: "stable", status: "success", value: 21 },
    ]);
    const state = h.runtime.snapshot().projection;
    expect(state.household.household.status).toBe("running");
    expect(state.projection_health.projection_health.capacity_degraded).toBe(
      true,
    );
    expect(
      Object.values(state.device).some((device) =>
        device.id.startsWith("new-"),
      ),
    ).toBe(false);
    expect(await h.homes.read(h.service.identity()!)).toEqual(binding);

    h.catalog.mockResolvedValue(householdCatalog());
    await h.service.loadDevices();
    await eventually(() =>
      Object.values(h.runtime.snapshot().projection.device).every(
        (device) => device.spec_status === "ready",
      ),
    );
    expect(await read(h, "device-a")).toMatchObject([{ status: "success" }]);
    expect(
      h.runtime.snapshot().projection.projection_health.projection_health
        .capacity_degraded,
    ).toBe(false);
  },
);

// REF-03/04/05/06: accepted commands may still be waiting for both external jobs.
test("refresh bursts retain both targets, bound cloud work, and finish without a page subscription", async () => {
  const h = await household();
  const app = createHouseholdRoutes(h.runtime);
  const firstStarted = deferred();
  const followupStarted = deferred();
  const first = deferred<ReturnType<typeof householdCatalog>>();
  const followup = deferred<ReturnType<typeof householdCatalog>>();
  const specStarted = deferred();
  const spec = deferred<Awaited<ReturnType<typeof h.specClient.read>>>();
  const finalCatalog = householdCatalog();
  finalCatalog.devices = finalCatalog.devices.map((device) => ({
    ...device,
    name: "After burst",
  }));
  const release = () => {
    first.resolve(householdCatalog());
    followup.resolve(finalCatalog);
    spec.resolve({ ...preparedSpec(), urn: specUrn, category: "refreshed" });
  };
  releases.push(release);
  h.catalog.mockClear();
  h.catalog.mockImplementationOnce(() => {
    firstStarted.resolve();
    return first.promise;
  });
  h.catalog.mockImplementationOnce(() => {
    followupStarted.resolve();
    return followup.promise;
  });
  h.catalog.mockResolvedValue(finalCatalog);
  h.specClient.read.mockImplementation(() => {
    specStarted.resolve();
    return spec.promise;
  });
  const refresh = (target: "directory" | "specs" | "all") =>
    app.request("/devices/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope_epoch: h.runtime.epoch, target }),
    });
  const receipt = await refresh("directory");
  expect(receipt.status).toBe(202);
  expect(
    commandResultSchema.parse(await receipt.json()).state_version,
  ).toMatchObject({
    scope_epoch: h.runtime.epoch,
  });
  await firstStarted.promise;
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      refresh(index % 2 ? "all" : "specs"),
    ),
  );
  expect(responses.every((response) => response.status === 202)).toBe(true);
  await specStarted.promise;
  expect(h.catalog.mock.calls).toHaveLength(1);
  expect(
    Object.values(h.runtime.snapshot().projection.device).some(
      (device) => device.category === "refreshed",
    ),
  ).toBe(false);

  const beforeReads = h.runtime.snapshot();
  for (const path of ["/state", "/diagnostics", "/setup/homes"]) {
    expect((await app.request(path)).status).toBe(200);
  }
  expect(h.runtime.snapshot()).toEqual(beforeReads);
  expect(h.catalog.mock.calls).toHaveLength(1);
  first.resolve(householdCatalog());
  await followupStarted.promise;
  release();
  await eventually(() =>
    Object.values(h.runtime.snapshot().projection.device).every(
      (device) =>
        device.name === "After burst" &&
        device.category === "refreshed" &&
        device.spec_status === "ready",
    ),
  );
  await nextTurn();
  expect(h.catalog.mock.calls.length).toBeLessThanOrEqual(2);
  expect(await read(h, "stable")).toMatchObject([{ status: "success" }]);
  expect(await h.homes.read(h.service.identity()!)).toEqual({
    homeId: "home-a",
  });
});

function roomCatalog(moved = false) {
  const catalog = householdCatalog();
  const roomId = moved ? "room-new" : "room-old";
  const roomName = moved ? "新房间" : "旧房间";
  return {
    homes: catalog.homes.map((home) =>
      home.id === "home-a"
        ? {
            ...home,
            rooms: [{ id: roomId, name: roomName, deviceIds: home.deviceIds }],
          }
        : home,
    ),
    devices: catalog.devices.map((device) =>
      device.home_id === "home-a"
        ? { ...device, room_id: roomId, room_name: roomName }
        : device,
    ),
  };
}

function stateFrames(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    next: async () => {
      const deadline = setTimeout(() => {
        reader.cancel().catch((backgroundError: unknown) => {
          console.error(
            "Failed to cancel state stream reader",
            backgroundError,
          );
        });
      }, 2_000);
      try {
        while (!buffered.includes("\n\n")) {
          const chunk = await reader.read();
          if (chunk.done)
            throw new Error("State stream ended before confirmation");
          buffered += decoder.decode(chunk.value, { stream: true });
        }
        const end = buffered.indexOf("\n\n");
        const text = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const event = /^event: (\w+)$/m.exec(text)?.[1];
        const payload = /^data: (.+)$/m.exec(text)?.[1];
        if (!payload) throw new Error("Expected a state frame");
        const data: unknown = JSON.parse(payload);
        return { event, data };
      } finally {
        clearTimeout(deadline);
      }
    },
    close: async () => {
      await reader.cancel();
      reader.releaseLock();
    },
  };
}

// DIR-03, PUB-01/02, WEB-01, SC-16: a subscription starts while the save is held.
test("a subscriber joining a room move receives one coherent inventory batch and stable committed values", async () => {
  const h = await household(roomCatalog());
  const app = createHouseholdRoutes(h.runtime);
  const saving = deferred();
  const saved = deferred<string>();
  releases.push(() => saved.resolve(new Date().toISOString()));
  h.repository.save.mockImplementationOnce(() => {
    saving.resolve();
    return saved.promise;
  });
  const moved = roomCatalog(true);
  h.catalog.mockResolvedValue(moved);
  const refresh = h.service.loadDevices();
  await saving.promise;
  const response = await app.request("/events");
  const stream = stateFrames(response);
  try {
    const initial = await stream.next();
    expect(initial.event).toBe("snapshot");
    const snapshot = snapshotSchema.parse(initial.data);
    expect(
      Object.values(snapshot.projection.device).map((device) => device.room_id),
    ).toEqual(["room-old", "room-old"]);
    saved.resolve(new Date().toISOString());
    await refresh;
    let sequence = snapshot.sequence;
    let receivedMove = false;
    while (!receivedMove) {
      const next = await stream.next();
      expect(next.event).toBe("state_change");
      const batch = stateChangeSchema.parse(next.data);
      expect(batch.scope_epoch).toBe(snapshot.scope_epoch);
      expect(batch.sequence).toBe(++sequence);
      const rooms = batch.changes.filter((change) => change.entity === "room");
      const devices = batch.changes.filter(
        (change) => change.entity === "device",
      );
      if (!rooms.length && !devices.length) continue;
      expect(rooms).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ op: "remove" }),
          expect.objectContaining({
            op: "upsert",
            value: expect.objectContaining({
              room_id: "room-new",
              name: "新房间",
            }),
          }),
        ]),
      );
      expect(devices).toHaveLength(2);
      for (const change of devices) {
        expect(change).toMatchObject({
          op: "upsert",
          value: { room_id: "room-new", room_name: "新房间" },
        });
      }
      receivedMove = true;
    }
    const accepted = structuredClone(h.runtime.snapshot());
    moved.homes[0]!.rooms[0]!.name = "Unpublished room";
    const changedDevice = moved.devices.find(
      (device) => "room_name" in device,
    )!;
    changedDevice.room_name = "Unpublished room";
    moved.devices.length = 0;
    expect(h.runtime.snapshot()).toEqual(accepted);
    expect(
      snapshotSchema.parse(await (await app.request("/state")).json()),
    ).toEqual(accepted);
    expect(await read(h, "stable")).toMatchObject([{ status: "success" }]);
  } finally {
    saved.resolve(new Date().toISOString());
    await refresh;
    await stream.close();
  }
});

// WEB-08, SC-18: exceeding one consumer's byte budget cannot hold up another.
test("a stalled page is reclaimed while a healthy page follows inventory changes and reconnects get current state", async () => {
  const h = await household();
  const app = createHouseholdRoutes(h.runtime);
  const slow = await app.request("/events");
  const healthy = stateFrames(await app.request("/events"));
  const extra: Response[] = [];
  const initial = snapshotSchema.parse((await healthy.next()).data);
  const largeName = "设备".repeat(12_000);
  const finalName = `39-${largeName}`;
  const consume = (async () => {
    let sequence = initial.sequence;
    for (;;) {
      const next = await healthy.next();
      expect(next.event).toBe("state_change");
      const batch = stateChangeSchema.parse(next.data);
      expect(batch.scope_epoch).toBe(initial.scope_epoch);
      expect(batch.sequence).toBe(++sequence);
      if (
        batch.changes.some(
          (change) =>
            change.entity === "device" &&
            change.op === "upsert" &&
            change.value.name === finalName,
        )
      )
        return;
    }
  })();
  // Attach a handler immediately; cleanup still awaits the actual consumer result.
  consume.catch(() => {});
  try {
    for (let index = 0; index < 40; index++) {
      const catalog = householdCatalog();
      h.catalog.mockResolvedValue({
        ...catalog,
        devices: catalog.devices.map((device) =>
          device.did === "device-a"
            ? { ...device, name: `${index}-${largeName}` }
            : device,
        ),
      });
      await h.service.loadDevices();
    }
    await consume;
    expect(h.runtime.ready).toBe(true);
    expect(await read(h, "stable")).toMatchObject([{ status: "success" }]);
    const requests = h.catalog.mock.calls.length;
    // A healthy stream plus fifteen new ones proves the stalled slot was released.
    for (let index = 0; index < 15; index++)
      extra.push(await app.request("/events"));
    expect(extra.every((response) => response.status === 200)).toBe(true);
    expect((await app.request("/events")).status).toBe(503);
    const reconnected = stateFrames(extra[0]!);
    try {
      const current = snapshotSchema.parse((await reconnected.next()).data);
      expect(
        Object.values(current.projection.device).find(
          (device) => device.id === "device-a",
        )?.name,
      ).toBe(finalName);
    } finally {
      await reconnected.close();
    }
    expect(h.catalog.mock.calls.length).toBe(requests);
  } finally {
    await healthy.close();
    await consume.catch(() => {});
    await slow.body?.cancel();
    await Promise.all(extra.map((response) => response.body?.cancel()));
  }
});
