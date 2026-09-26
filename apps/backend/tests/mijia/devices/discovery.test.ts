import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { DeviceDiscovery } from "../../../src/mijia/devices/discovery";
import { MijiaError } from "../../../src/mijia/errors";
import { deferred, nextTurn } from "../../support/async";
import { accountClient, specUrn } from "../../support/protocol-fixtures";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) restore();
  jest.useRealTimers();
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
  let current = client;
  const commit = mock<
    ConstructorParameters<typeof DeviceDiscovery>[0]["commit"]
  >(() => Promise.resolve());
  const onScopeChanged = mock(() => {});
  const discovery = new DeviceDiscovery({
    commit,
    onScopeChanged,
    onChange: () => {},
    onDevices: () => {},
    currentAccount: () => current,
    activeAccount: (account) => account === current,
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
  return {
    discovery,
    client,
    commit,
    onScopeChanged,
    replaceAccount: (account: typeof client) => {
      current = account;
      restores.push(() => account.dispose());
    },
  };
}

describe("accepted device access index", () => {
  test("revokes moved membership before an unsaved candidate can grant new devices", () => {
    const { discovery, client } = discoveryHarness();
    const originalRevision = discovery.revision;
    const next = catalog();
    const device = next.devices.find((item) => item.did === "revoked")!;
    device.home_id = "home-b";
    next.devices.push({
      did: "new",
      home_id: "home-a",
      model: "test.sensor",
      spec_type: specUrn,
      isOnline: true,
    });
    const revocation = discovery.revocation(next);
    expect(revocation?.deviceIds).toEqual(["revoked"]);
    expect(discovery.find("revoked")).toBeDefined();
    if (!revocation) throw new Error("Expected a device revocation");
    discovery.set(revocation.catalog);
    discovery.retain(next, client);
    discovery.fail(new MijiaError("home_storage"));
    expect(discovery.find("revoked")).toBeUndefined();
    expect(discovery.find("new")).toBeUndefined();
    expect(discovery.find("foreign")).toBeUndefined();
    expect(discovery.find("stable")).toMatchObject({ isOnline: false });
    expect(discovery.revision).toBe(originalRevision);
    expect(discovery.catalogConfirmed).toBe(true);
    expect(discovery.state.status).toBe("error");
    discovery.set(next);
    expect(discovery.find("new")).toBeDefined();
  });

  test.each(["model", "spec"])(
    "a %s definition change keeps the accepted device until its replacement is saved",
    (kind) => {
      const { discovery } = discoveryHarness();
      const previous = discovery.find("revoked");
      const next = catalog();
      const replacement = next.devices.find(
        (device) => device.did === "revoked",
      )!;
      if (kind === "model") replacement.model = "test.replacement";
      else replacement.spec_type = specUrn.replace(/:1$/, ":2");
      expect(discovery.revocation(next)).toBeUndefined();
      expect(discovery.definitionChanges(next)).toEqual(["revoked"]);
      expect(discovery.find("revoked")).toBe(previous);
      discovery.set(next);
      expect(discovery.find("revoked")).toBe(replacement);
    },
  );

  test("losing a home revokes all its devices even if detail rows still mention them", () => {
    const { discovery } = discoveryHarness();
    const next = catalog();
    next.homes = next.homes.filter((home) => home.id !== "home-a");
    const revocation = discovery.revocation(next);
    expect(revocation).toMatchObject({
      homeLost: true,
      deviceIds: ["stable", "revoked"],
    });
    if (!revocation) throw new Error("Expected a household revocation");
    discovery.set(revocation.catalog);
    expect(discovery.list()).toEqual([]);
    expect(discovery.homeSnapshot()).toMatchObject({
      selectedHomeId: "home-a",
      status: "unavailable",
    });
    expect(() => discovery.requireHome()).toThrow(
      new MijiaError("home_unavailable"),
    );
  });

  test("resetting during a directory request cancels confirmation and rejects its late commit", async () => {
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
    discovery.reset();
    expect(requestSignal?.aborted).toBe(true);
    expect(discovery.catalogConfirmed).toBe(false);
    expect(discovery.revision).not.toBe(originalRevision);
    response.resolve(catalog());
    await pending;
    expect(commit).not.toHaveBeenCalled();
    expect(discovery.catalogConfirmed).toBe(false);
  });
});

describe("supplier directory retry deadline", () => {
  test("manual, background, queued and periodic refreshes wait for Retry-After", async () => {
    jest.useFakeTimers();
    const { discovery, client, commit } = discoveryHarness();
    const deadline = Date.now() + 11 * 60_000;
    const response = deferred<Awaited<ReturnType<typeof client.getCatalog>>>();
    const request = spyOn(client, "getCatalog")
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValue(catalog());
    restores.push(() => request.mockRestore());
    commit.mockImplementation(async (next) => discovery.set(next));
    const first = discovery.load();
    const joined = discovery.load(true);
    response.reject(
      new MijiaError("network", {
        retry_after_at: new Date(deadline).toISOString(),
      }),
    );
    await Promise.all([first, joined]);
    await nextTurn();
    await discovery.load();
    await discovery.load(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(discovery.state.status).toBe("error");
    jest.advanceTimersByTime(5 * 60_000);
    await nextTurn();
    expect(request).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(6 * 60_000 - 1);
    await nextTurn();
    expect(request).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await nextTurn();
    expect(request).toHaveBeenCalledTimes(2);
    expect(discovery.state.status).toBe("ready");
  });

  test("replacing credentials keeps the stable account deadline", async () => {
    jest.useFakeTimers();
    const { discovery, client, commit, replaceAccount } = discoveryHarness();
    const deadline = Date.now() + 60_000;
    const original = spyOn(client, "getCatalog").mockRejectedValue(
      new MijiaError("network", {
        retry_after_at: new Date(deadline).toISOString(),
      }),
    );
    const renewed = accountClient({ serviceToken: "renewed-service-token" });
    const replacement = spyOn(renewed, "getCatalog").mockResolvedValue(
      catalog(),
    );
    restores.push(
      () => original.mockRestore(),
      () => replacement.mockRestore(),
    );
    commit.mockImplementation(async (next) => discovery.set(next));
    await discovery.load();
    discovery.pause();
    discovery.acceptHome("home-a");
    replaceAccount(renewed);
    await discovery.load();
    jest.advanceTimersByTime(59_999);
    await nextTurn();
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await nextTurn();
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(discovery.homeSnapshot().selectedHomeId).toBe("home-a");
  });

  test("another account does not inherit the previous account deadline", async () => {
    jest.useFakeTimers();
    const { discovery, client, replaceAccount } = discoveryHarness();
    const original = spyOn(client, "getCatalog").mockRejectedValue(
      new MijiaError("network", {
        retry_after_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const other = accountClient({ userId: "100002" });
    const replacement = spyOn(other, "getCatalog").mockResolvedValue(catalog());
    restores.push(
      () => original.mockRestore(),
      () => replacement.mockRestore(),
    );
    await discovery.load();
    replaceAccount(other);
    await discovery.load();
    expect(replacement).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    await nextTurn();
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  test("an automatic retry uses renewed credentials for the same account", async () => {
    jest.useFakeTimers();
    const { discovery, client, replaceAccount } = discoveryHarness();
    const original = spyOn(client, "getCatalog").mockRejectedValue(
      new MijiaError("network", {
        retry_after_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const renewed = accountClient({ serviceToken: "renewed-service-token" });
    const replacement = spyOn(renewed, "getCatalog").mockResolvedValue(
      catalog(),
    );
    restores.push(
      () => original.mockRestore(),
      () => replacement.mockRestore(),
    );
    await discovery.load();
    replaceAccount(renewed);
    jest.advanceTimersByTime(59_999);
    await nextTurn();
    expect(replacement).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await nextTurn();
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  test("retained directory saves can retry locally while cloud requests are paused", async () => {
    jest.useFakeTimers();
    const { discovery, client, commit } = discoveryHarness();
    const request = spyOn(client, "getCatalog").mockRejectedValue(
      new MijiaError("network", {
        retry_after_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    restores.push(() => request.mockRestore());
    await discovery.load();
    const pending = catalog();
    discovery.retain(pending, client);
    await discovery.load(true, true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]).toBe(pending);
    await discovery.load();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
