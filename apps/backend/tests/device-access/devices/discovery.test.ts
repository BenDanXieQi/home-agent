import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DeviceDiscovery } from "../../../src/mijia/devices/discovery";
import { MijiaError } from "../../../src/mijia/errors";
import { deferred } from "../../support/async";
import { accountClient, specUrn } from "../../support/protocol-fixtures";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) restore();
});

function catalog() {
  return {
    homes: [
      {
        id: "home-a",
        name: "Home A",
        shared: false,
        deviceIds: ["stable", "revoked"],
        rooms: [],
      },
      {
        id: "home-b",
        name: "Home B",
        shared: true,
        deviceIds: ["foreign"],
        rooms: [],
      },
    ],
    devices: [
      {
        did: "stable",
        home_id: "home-a",
        model: "test.sensor",
        spec_type: specUrn,
        isOnline: false,
      },
      {
        did: "revoked",
        home_id: "home-a",
        model: "test.sensor",
        spec_type: specUrn,
        isOnline: true,
      },
      {
        did: "foreign",
        home_id: "home-b",
        model: "test.sensor",
        spec_type: specUrn,
        isOnline: true,
      },
    ],
  } satisfies Parameters<DeviceDiscovery["set"]>[0];
}

function discoveryHarness() {
  const client = accountClient();
  const commit = mock<
    ConstructorParameters<typeof DeviceDiscovery>[0]["commit"]
  >(() => Promise.resolve());
  const onScopeChanged = mock(() => {});
  const discovery = new DeviceDiscovery({
    commit,
    onScopeChanged,
    onChange: () => {},
    onDevices: () => {},
    currentAccount: () => client,
    activeAccount: (account) => account === client,
    stopped: () => false,
    renewalFailed: () => false,
    renew: () => Promise.resolve(),
  });
  restores.push(() => {
    discovery.reset();
    client.dispose();
  });
  discovery.acceptHome("home-a");
  discovery.set(catalog());
  return { discovery, client, commit, onScopeChanged };
}

describe("accepted device access index", () => {
  test.each(["moved", "model-changed", "spec-changed"])(
    "revokes %s membership before an unsaved candidate can grant new devices",
    (change) => {
      const { discovery, client } = discoveryHarness();
      const originalRevision = discovery.revision;
      const next = catalog();
      const device = next.devices.find((item) => item.did === "revoked")!;
      if (change === "moved") device.home_id = "home-b";
      if (change === "model-changed") device.model = "test.replacement";
      if (change === "spec-changed")
        device.spec_type = specUrn.replace(/:1$/, ":2");
      next.devices.push({
        did: "new",
        home_id: "home-a",
        model: "test.sensor",
        spec_type: specUrn,
        isOnline: true,
      });
      discovery.revoke(next);
      discovery.retain(next, client);
      discovery.fail(new MijiaError("home_storage"));
      expect(discovery.find("revoked")).toBeUndefined();
      expect(discovery.find("new")).toBeUndefined();
      expect(discovery.find("foreign")).toBeUndefined();
      expect(discovery.find("stable")).toMatchObject({ isOnline: false });
      expect(discovery.revision).not.toBe(originalRevision);
      expect(discovery.catalogConfirmed).toBe(true);
      expect(discovery.state.status).toBe("error");
      discovery.set(next);
      expect(discovery.find("new")).toBeDefined();
    },
  );

  test("losing a home revokes all its devices even if detail rows still mention them", () => {
    const { discovery } = discoveryHarness();
    const next = catalog();
    next.homes = next.homes.filter((home) => home.id !== "home-a");
    discovery.revoke(next);
    expect(discovery.list()).toEqual([]);
    expect(discovery.homeSnapshot()).toMatchObject({
      selectedHomeId: "home-a",
      status: "unavailable",
    });
    expect(() => discovery.requireHome()).toThrow(
      new MijiaError("home_unavailable"),
    );
  });

  test("suspending during a directory request cancels confirmation and rejects its late commit", async () => {
    const { discovery, client, commit } = discoveryHarness();
    const started = deferred();
    const response = deferred<Awaited<ReturnType<typeof client.getCatalog>>>();
    let requestSignal: AbortSignal | undefined;
    const request = spyOn(client, "getCatalog").mockImplementation((signal) => {
      requestSignal = signal;
      started.resolve();
      return response.promise;
    });
    restores.push(() => request.mockRestore());
    const originalRevision = discovery.revision;
    const pending = discovery.load();
    await started.promise;
    discovery.suspend();
    expect(requestSignal?.aborted).toBe(true);
    expect(discovery.catalogConfirmed).toBe(false);
    expect(discovery.revision).not.toBe(originalRevision);
    response.resolve(catalog());
    await pending;
    expect(commit).not.toHaveBeenCalled();
    expect(discovery.catalogConfirmed).toBe(false);
  });
});
