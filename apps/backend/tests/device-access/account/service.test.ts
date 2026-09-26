import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MijiaService } from "../../../src/mijia/service";
import { MiCloud } from "../../../src/mijia/protocols/micloud";
import { DirectoryNotifications } from "../../../src/mijia/devices/directory-notifications";
import { Go2RtcAdapter } from "../../../src/mijia/media/go2rtc-adapter";
import { MijiaError } from "../../../src/mijia/errors";
import { CredentialStoreError } from "../../../src/credentials/store";
import { accountClient } from "../../support/protocol-fixtures";
import {
  credentialStore,
  homeSelectionStore,
} from "../../support/account-fixtures";
import { deferred, eventually } from "../../support/async";

const services: MijiaService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  mock.restore();
});

function harness(
  selection?: Parameters<typeof homeSelectionStore>[0],
  homeCount = 1,
) {
  const store = credentialStore();
  const homes = homeSelectionStore(selection);
  const catalog: Awaited<ReturnType<MiCloud["getCatalog"]>> = {
    homes: Array.from({ length: homeCount }, (_, index) => ({
      id: `home-${index + 1}`,
      name: `Home ${index + 1}`,
      shared: false,
      deviceIds: [],
      rooms: [],
    })),
    devices: [],
  };
  const candidate = accountClient();
  spyOn(MiCloud.prototype, "renewSession").mockResolvedValue(candidate);
  spyOn(MiCloud.prototype, "getCatalog").mockResolvedValue(catalog);
  spyOn(MiCloud.prototype, "getProfile").mockResolvedValue({
    name: "Test account",
    avatarUrl: null,
  });
  // The shared MQTT transport and media owners have their own lifecycle suites.
  // Keep account persistence tests isolated from those external side effects.
  spyOn(DirectoryNotifications.prototype, "update").mockImplementation(
    () => {},
  );
  spyOn(Go2RtcAdapter.prototype, "reset").mockResolvedValue(undefined);
  spyOn(Go2RtcAdapter.prototype, "close").mockResolvedValue(undefined);
  const service = new MijiaService({
    credentialStore: store,
    homeSelectionStore: homes,
    readGo2rtcUrl: async () => "http://127.0.0.1:1984",
  });
  services.push(service);
  const commit = mock<Parameters<MijiaService["attachHousehold"]>[0]["commit"]>(
    async (_candidate, assert) => {
      assert();
      return () => {
        assert();
      };
    },
  );
  service.attachHousehold({
    restore: async () => {},
    commit,
    ready: () => false,
    specification: () => {
      throw new Error("No property capability in account fixture");
    },
  });
  return { service, store, homes, commit, candidate };
}

describe("account persistence and access ownership", () => {
  test("restoring an account is not accepted until the complete credential write succeeds", async () => {
    const h = harness();
    const saved = deferred();
    h.store.write.mockImplementation(() => saved.promise);
    const initialization = h.service.initialize();
    await eventually(() => h.store.write.mock.calls.length === 1);
    expect(h.service.identity()).toBeNull();
    expect(h.service.snapshot().account.status).toBe("restoring");
    expect(h.commit).not.toHaveBeenCalled();
    saved.resolve();
    await initialization;
    expect(h.store.write.mock.calls[0]).toEqual([
      "mijia",
      {
        micloud: h.candidate.exportSession(),
        oauth: expect.objectContaining({ accessToken: "test-access-token" }),
      },
    ]);
    expect(h.service.snapshot().account.status).toBe("authenticated");
    expect(h.service.identity()).toBe('["cn","100001"]');
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["no selection and one home", undefined, 1, "home-1", 1],
    ["explicitly disconnected home", { homeId: null }, 1, null, 0],
    ["multiple homes", undefined, 2, null, 0],
  ] as const)(
    "default selection respects %s",
    async (_label, selection, count, expected, writes) => {
      const h = harness(selection, count);
      await h.service.initialize();
      expect(h.service.homes().selectedHomeId).toBe(expected);
      expect(h.homes.write).toHaveBeenCalledTimes(writes);
      if (writes)
        expect(h.homes.write.mock.calls[0]?.slice(0, 2)).toEqual([
          '["cn","100001"]',
          "home-1",
        ]);
    },
  );

  test("failed credential persistence does not publish an authenticated owner or directory", async () => {
    const h = harness();
    h.store.write.mockRejectedValue(new CredentialStoreError());
    const dispose = spyOn(h.candidate, "dispose");
    await h.service.initialize();
    expect(h.service.identity()).toBeNull();
    expect(h.service.snapshot().account).toMatchObject({
      status: "restore_error",
      error: { code: "mijia_credential_storage" },
    });
    expect(h.commit).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("failed new QR attempt cannot replace the accepted account", async () => {
    const h = harness();
    await h.service.initialize();
    const account = h.service.snapshot().account;
    spyOn(MiCloud.prototype, "createLogin").mockRejectedValue(
      new MijiaError("network"),
    );
    h.service.startLogin();
    await eventually(() => h.service.loginPublic().status === "error");
    expect(h.service.snapshot().account).toEqual(account);
    expect(h.service.identity()).toBe('["cn","100001"]');
    expect(h.store.write).toHaveBeenCalledTimes(1);
  });

  test("failed credential deletion preserves the account; the queue permits a successful retry", async () => {
    const h = harness();
    await h.service.initialize();
    h.store.remove.mockRejectedValueOnce(new CredentialStoreError());
    await expect(h.service.logout()).rejects.toMatchObject({
      reason: "credential_storage",
    });
    expect(h.service.snapshot().account.status).toBe("authenticated");
    expect(h.service.identity()).toBe('["cn","100001"]');
    await h.service.logout();
    expect(h.service.snapshot().account.status).toBe("idle");
    expect(h.service.identity()).toBeNull();
    expect(h.store.remove).toHaveBeenCalledTimes(2);
  });

  test("remote cleanup failure after credential deletion never resurrects authorization", async () => {
    const h = harness({ homeId: null });
    await h.service.initialize();
    const close = spyOn(Go2RtcAdapter.prototype, "close").mockRejectedValueOnce(
      new MijiaError("go2rtc_cleanup"),
    );
    await expect(h.service.logout()).rejects.toMatchObject({
      reason: "go2rtc_cleanup",
    });
    expect(await h.store.read("mijia")).toBeUndefined();
    expect(h.service.identity()).toBeNull();
    expect(h.service.snapshot().account.status).toBe("idle");
    await h.service.logout();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
