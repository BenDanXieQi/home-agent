import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AccountMaintenance } from "../../../src/mijia/account/maintenance";
import {
  renewAccountSession,
  restoreAccountSession,
} from "../../../src/mijia/account/session";
import { MijiaError } from "../../../src/mijia/errors";
import { MiCloud } from "../../../src/mijia/protocols/micloud";
import { accountClient } from "../../support/protocol-fixtures";
import {
  accountRecord,
  credentialStore,
  oauthSession,
} from "../../support/account-fixtures";
import { deferred, nextTurn } from "../../support/async";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  mock.restore();
});

function client() {
  const cloud = accountClient();
  cleanups.push(() => cloud.dispose());
  return cloud;
}

function maintenance() {
  let current = client();
  let oauth = oauthSession();
  const commit = mock<
    ConstructorParameters<typeof AccountMaintenance>[0]["commitRenewed"]
  >(async (_previous, candidate, assert) => {
    assert();
    current = candidate.client;
    oauth = candidate.oauth;
  });
  const failure = mock(async (_account: MiCloud, _error: MijiaError) => {});
  const owner = new AccountMaintenance({
    currentAccount: () => current,
    currentOAuth: () => oauth,
    isActive: (cloud) => cloud === current,
    acceptsWork: () => true,
    committing: () => false,
    isLoginActive: () => false,
    readStore: () => credentialStore(),
    commitRestored: async () => {},
    commitRenewed: commit,
    onRestoreState: () => {},
    onRenewalFailure: failure,
  });
  cleanups.push(() => owner.shutdown());
  return { owner, account: current, commit, failure, current: () => current };
}

describe("complete account session", () => {
  test("missing OAuth prevents restoring a partial account or attempting vendor renewal", async () => {
    const renew = spyOn(MiCloud.prototype, "renewSession");
    await expect(
      restoreAccountSession(
        credentialStore({ micloud: accountRecord().micloud }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "authentication" });
    expect(renew).not.toHaveBeenCalled();
  });

  test("a catalog failure disposes only the candidate and leaves accepted credentials usable", async () => {
    const accepted = client();
    const candidate = client();
    spyOn(accepted, "renewSession").mockResolvedValue(candidate);
    spyOn(candidate, "getCatalog").mockRejectedValue(new MijiaError("network"));
    const dispose = spyOn(candidate, "dispose");
    await expect(
      renewAccountSession(
        accepted,
        oauthSession(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "network" });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(accepted.getCredentials().userId).toBe("100001");
  });

  test("OAuth rejection prevents a complete candidate even after MiCloud succeeds", async () => {
    const accepted = client();
    const candidate = client();
    spyOn(accepted, "renewSession").mockResolvedValue(candidate);
    spyOn(candidate, "getCatalog").mockResolvedValue({
      homes: [],
      devices: [],
    });
    const dispose = spyOn(candidate, "dispose");
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    await expect(
      renewAccountSession(
        accepted,
        oauthSession({ expiresAt: 1 }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "authentication" });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(accepted.exportSession().serviceToken).toBe("test-service-token");
  });

  test("cancelling while storage is read prevents even starting renewal", async () => {
    const record =
      deferred<
        Awaited<ReturnType<ReturnType<typeof credentialStore>["read"]>>
      >();
    const store = credentialStore();
    store.read.mockImplementation(() => record.promise);
    const renew = spyOn(MiCloud.prototype, "renewSession");
    const controller = new AbortController();
    const result = restoreAccountSession(store, controller.signal);
    controller.abort();
    record.resolve({ value: accountRecord() });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(renew).not.toHaveBeenCalled();
  });
});

describe("account maintenance ownership", () => {
  test("coalesces concurrent renewals and disposes a candidate rejected by persistence", async () => {
    const h = maintenance();
    const candidate = client();
    const catalog = deferred<Awaited<ReturnType<MiCloud["getCatalog"]>>>();
    const renew = spyOn(h.account, "renewSession").mockResolvedValue(candidate);
    spyOn(candidate, "getCatalog").mockImplementation(() => catalog.promise);
    const dispose = spyOn(candidate, "dispose");
    h.commit.mockRejectedValue(new MijiaError("credential_storage"));
    const first = h.owner.renew(h.account);
    const second = h.owner.renew(h.account);
    expect(first).toBe(second);
    catalog.resolve({ homes: [], devices: [] });
    await first;
    expect(renew).toHaveBeenCalledTimes(1);
    expect(h.current()).toBe(h.account);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(h.failure.mock.calls[0]?.[1].reason).toBe("credential_storage");
  });

  test("Retry-After survives manual retry and rescheduling the same account", async () => {
    const h = maintenance();
    const deadline = Date.now() + 60_000;
    const renew = spyOn(h.account, "renewSession").mockRejectedValue(
      new MijiaError("network", {
        retry_after_at: new Date(deadline).toISOString(),
      }),
    );
    await h.owner.renew(h.account);
    h.owner.scheduleRenewal(h.account);
    await h.owner.renew(h.account);
    await h.owner.rejectOAuth(h.account);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(h.owner.renewalFailed(h.account)).toBe(true);
    expect(h.current()).toBe(h.account);
  });

  test("token rejection during ordinary renewal forces refresh and rejects the same token", async () => {
    const h = maintenance();
    const candidate = client();
    const catalog = deferred<Awaited<ReturnType<MiCloud["getCatalog"]>>>();
    spyOn(h.account, "renewSession").mockResolvedValue(candidate);
    spyOn(candidate, "getCatalog").mockImplementation(() => catalog.promise);
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        code: 0,
        result: {
          access_token: "test-access-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
        },
      }),
    );
    const task = h.owner.renew(h.account);
    const rejected = h.owner.rejectOAuth(h.account);
    catalog.resolve({ homes: [], devices: [] });
    await Promise.all([task, rejected]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.failure.mock.calls[0]?.[1].reason).toBe("authentication");
  });

  test("shutdown rejects a late vendor result even when transport ignores abort", async () => {
    const h = maintenance();
    const candidate = client();
    const catalog = deferred<Awaited<ReturnType<MiCloud["getCatalog"]>>>();
    spyOn(h.account, "renewSession").mockResolvedValue(candidate);
    spyOn(candidate, "getCatalog").mockImplementation(() => catalog.promise);
    const dispose = spyOn(candidate, "dispose");
    const task = h.owner.renew(h.account);
    await nextTurn();
    const shutdown = h.owner.shutdown();
    catalog.resolve({ homes: [], devices: [] });
    await Promise.all([task, shutdown]);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.failure).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
