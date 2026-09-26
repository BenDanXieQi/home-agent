import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { MijiaError } from "../../src/mijia/errors";
import { MiCloudError } from "../../src/mijia/protocols/micloud";
import { deferred, eventually } from "../support/async";
import {
  householdCatalog,
  runningHousehold,
} from "../support/household-harness";
import { accountClient } from "../support/protocol-fixtures";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const fixture of households.splice(0)) await fixture.close();
});

async function household() {
  const result = await runningHousehold();
  households.push(result);
  return result;
}

function read(
  h: Awaited<ReturnType<typeof runningHousehold>>,
  did = "device-a",
) {
  return h.service.readProperties(
    [{ did, siid: 2, piid: 1 }],
    new AbortController().signal,
  );
}

async function holdRead(h: Awaited<ReturnType<typeof runningHousehold>>) {
  const started = deferred<AbortSignal | undefined>();
  const response = deferred<Awaited<ReturnType<typeof h.properties>>>();
  h.properties.mockImplementationOnce((_batch, signal, onStarted) => {
    onStarted?.(new Date().toISOString());
    started.resolve(signal);
    return response.promise;
  });
  const outcome = read(h).then(
    (observations) => ({ accepted: true as const, observations }),
    (error: unknown) => ({ accepted: false as const, error }),
  );
  const signal = await started.promise;
  const release = () =>
    response.resolve([{ did: "device-a", siid: 2, piid: 1, value: 99 }]);
  releases.push(release);
  return { release, outcome, signal };
}

describe("running household read authorization", () => {
  test("source notifications use a detached public view without materializing the device list", async () => {
    const h = await household();
    const full = h.service.snapshot();
    expect(full.devices.items).toHaveLength(2);
    const snapshot = spyOn(h.service, "snapshot");
    releases.push(() => snapshot.mockRestore());
    const version = h.runtime.version();

    h.service.flushChanges();
    const source = h.service.sourceSnapshot();
    expect(snapshot).not.toHaveBeenCalled();
    expect(h.runtime.version()).toEqual(version);
    expect(source).toMatchObject({
      accountId: h.service.identity(),
      account: full.account,
      homes: full.homes,
      revision: full.revision,
      binding: full.binding,
      login: h.service.loginPublic(),
      directory: { status: "ready" },
    });
    expect(source).not.toHaveProperty("devices");
    expect(source).not.toHaveProperty("loginAttempt");
    expect(source.directory).not.toHaveProperty("items");

    source.homes.items[0]!.name = "Changed by reader";
    if (source.account.status === "authenticated" && source.account.profile)
      source.account.profile.name = "Changed by reader";
    expect(h.service.sourceSnapshot().homes).toEqual(full.homes);
    expect(h.service.sourceSnapshot().account).toEqual(full.account);
  });

  test("missing room-member details cannot revoke an in-flight read", async () => {
    const h = await household();
    const pending = await holdRead(h);
    const original = householdCatalog();
    const next = {
      ...original,
      homes: original.homes.map((home) =>
        home.id === "home-a"
          ? {
              ...home,
              deviceIds: ["stable"],
              rooms: [
                { id: "room-a", name: "Room A", deviceIds: ["device-a"] },
              ],
            }
          : home,
      ),
      devices: original.devices.filter((device) => device.did !== "device-a"),
    };
    h.catalog.mockResolvedValue(next);
    await h.service.loadDevices();
    expect(pending.signal?.aborted).toBe(false);
    expect(h.runtime.ready).toBe(true);
    pending.release();
    expect(await pending.outcome).toMatchObject({
      accepted: true,
      observations: [{ status: "success", value: 99 }],
    });
  });

  test("a complete directory revokes in-flight and new device access before a failed save", async () => {
    const h = await household();
    expect(await read(h)).toMatchObject([{ status: "success", value: 21 }]);
    const pending = await holdRead(h);
    const next = householdCatalog();
    next.devices = next.devices.filter((device) => device.did !== "device-a");
    next.homes[0]!.deviceIds = ["stable", "new-device"];
    next.devices.push({ ...next.devices[0]!, did: "new-device" });
    h.catalog.mockResolvedValue(next);
    h.repository.save.mockRejectedValueOnce(new MijiaError("home_storage"));
    await h.service.loadDevices();

    expect(pending.signal?.aborted).toBe(true);
    expect(await pending.outcome).toMatchObject({ accepted: false });
    expect(h.runtime.ready).toBe(true);
    expect(
      h.runtime.snapshot().projection.projection_health.projection_health
        .storage_degraded,
    ).toBe(true);
    await expect(read(h)).rejects.toMatchObject({ reason: "device_not_found" });
    pending.release();
    await eventually(() =>
      Object.values(h.runtime.snapshot().projection.device).some(
        (device) =>
          device.id === "new-device" && device.spec_status === "ready",
      ),
    );
    expect(await read(h, "new-device")).toMatchObject([{ status: "success" }]);
    expect(await read(h, "stable")).toMatchObject([
      { status: "success", value: 21 },
    ]);
  });

  test("a rejected home change leaves current reads authorized", async () => {
    const h = await household();
    const pending = await holdRead(h);
    const epoch = h.runtime.epoch;
    await expect(h.runtime.selectHome(epoch, "home-b")).rejects.toMatchObject({
      reason: "binding_conflict",
    });
    expect(h.runtime.epoch).toBe(epoch);
    expect(h.runtime.ready).toBe(true);
    expect(pending.signal?.aborted).toBe(false);
    pending.release();
    expect(await pending.outcome).toMatchObject({ accepted: true });
    expect(await read(h)).toMatchObject([{ status: "success" }]);
    await expect(read(h, "device-b")).rejects.toMatchObject({
      reason: "device_not_found",
    });
    expect(h.homes.write).not.toHaveBeenCalled();
  });

  test("an ordinary directory refresh error keeps a confirmed household readable", async () => {
    const h = await household();
    const epoch = h.runtime.epoch;
    h.catalog.mockRejectedValueOnce(new MiCloudError("network"));
    await h.service.loadDevices();
    expect(h.service.snapshot().devices.status).toBe("error");
    expect(h.runtime.snapshot().projection.household.household).toMatchObject({
      status: "running",
      sync_status: "error",
    });
    expect(h.runtime.epoch).toBe(epoch);
    expect(await read(h)).toMatchObject([
      { status: "success", value: 21, delivery_kind: "baseline" },
    ]);
    await expect(read(h, "device-b")).rejects.toMatchObject({
      reason: "device_not_found",
    });
  });

  test.each(["network", "authentication", "account-changed"] as const)(
    "renewal %s failure has the correct account-wide effect on active reads",
    async (reason) => {
      const h = await household();
      const pending = await holdRead(h);
      h.catalog.mockRejectedValueOnce(new MiCloudError("authentication"));
      if (reason === "account-changed")
        h.renewal.mockResolvedValueOnce(accountClient({ userId: "200002" }));
      else h.renewal.mockRejectedValueOnce(new MiCloudError(reason));
      await h.service.loadDevices();
      expect(h.renewal).toHaveBeenCalledTimes(2);

      if (reason !== "network") {
        expect(h.service.snapshot().account.status).toBe("reauth_required");
        expect(h.service.identity()).toBeNull();
        expect(h.store.write).toHaveBeenCalledTimes(1);
        expect(h.runtime.ready).toBe(false);
        expect(pending.signal?.aborted).toBe(true);
        expect(await pending.outcome).toMatchObject({ accepted: false });
        await expect(read(h)).rejects.toMatchObject({
          reason: "devices_failed",
        });
      } else {
        expect(h.service.snapshot().account.status).toBe("authenticated");
        expect(h.runtime.ready).toBe(true);
        expect(pending.signal?.aborted).toBe(false);
      }
      pending.release();
      if (reason === "network") {
        expect(await pending.outcome).toMatchObject({
          accepted: true,
          observations: [{ status: "success", value: 99 }],
        });
        expect(await read(h)).toMatchObject([{ status: "success", value: 21 }]);
      }
    },
  );
});
