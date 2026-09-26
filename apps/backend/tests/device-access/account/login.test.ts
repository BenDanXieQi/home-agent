import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { LoginFlow } from "../../../src/mijia/account/login-flow";
import { MijiaError } from "../../../src/mijia/errors";
import { MiCloud } from "../../../src/mijia/protocols/micloud";
import { deferred, eventually, nextTurn } from "../../support/async";

const flows: LoginFlow[] = [];
afterEach(() => {
  for (const login of flows.splice(0)) login.dispose();
  mock.restore();
});

function flow() {
  const commit = mock<ConstructorParameters<typeof LoginFlow>[0]>(
    async () => {},
  );
  const login = new LoginFlow(commit, () => {});
  flows.push(login);
  return { login, commit };
}

function qr() {
  return {
    qrImage: "data:image/png;base64,dGVzdA==",
    expiresAt: Date.now() + 60_000,
    pollIntervalMs: 2_000,
  };
}

async function challenge() {
  const h = flow();
  spyOn(MiCloud.prototype, "createLogin").mockResolvedValue(qr());
  spyOn(MiCloud.prototype, "pollLogin").mockResolvedValue({
    status: "security-required",
    verificationUrl: "https://account.xiaomi.com/test-challenge",
  });
  h.login.start();
  await eventually(() => h.login.state.status === "security_required");
  const id = h.login.publicSnapshot().id;
  if (!id) throw new Error("Expected active login ID");
  return { ...h, id };
}

describe("interactive login candidate", () => {
  test("replaced QR responses cannot overwrite the new attempt or expose its material", async () => {
    const h = flow();
    const oldQr = deferred<Awaited<ReturnType<MiCloud["createLogin"]>>>();
    const newQr = deferred<Awaited<ReturnType<MiCloud["createLogin"]>>>();
    spyOn(MiCloud.prototype, "createLogin")
      .mockImplementationOnce(() => oldQr.promise)
      .mockImplementationOnce(() => newQr.promise);
    h.login.start();
    const oldId = h.login.publicSnapshot().id!;
    h.login.start();
    const current = h.login.publicSnapshot();
    oldQr.resolve(qr());
    await nextTurn();
    expect(h.login.publicSnapshot()).toEqual(current);
    expect(() => h.login.material(oldId)).toThrow(MijiaError);
    expect(h.commit).not.toHaveBeenCalled();
    h.login.cancel(current.id!);
    newQr.resolve(qr());
    await nextTurn();
    expect(h.login.state.status).toBe("cancelled");
  });

  test("public login state omits QR and verification secrets and material versions are stable", async () => {
    const h = await challenge();
    const state = h.login.publicSnapshot();
    expect(state).toEqual({
      id: h.id,
      status: "security_required",
      error: null,
      material_version: expect.any(Number),
    });
    expect(h.login.publicSnapshot()).toEqual(state);
    expect(h.login.material(h.id)).toMatchObject({
      id: h.id,
      material_version: state.material_version,
      verification_url: "https://account.xiaomi.com/test-challenge",
      qr_image_url: null,
    });
    h.login.cancel(h.id);
    expect(() => h.login.material(h.id)).toThrow(MijiaError);
    expect(h.login.publicSnapshot().material_version).toBeGreaterThan(
      state.material_version,
    );
  });

  test("an invalid code preserves the challenge for retry; transport failure destroys it", async () => {
    const h = await challenge();
    const submit = spyOn(MiCloud.prototype, "submitSecurityCode")
      .mockRejectedValueOnce(new MijiaError("security_code_invalid"))
      .mockRejectedValueOnce(new MijiaError("network"));
    await h.login.verifyLogin(h.id, "1234");
    expect(h.login.state).toMatchObject({
      status: "security_required",
      error: { code: "mijia_security_code_invalid" },
    });
    expect(h.login.active).toBe(true);
    await h.login.verifyLogin(h.id, "5678");
    expect(h.login.state).toMatchObject({
      status: "error",
      error: { code: "mijia_network" },
    });
    expect(h.login.active).toBe(false);
    await expect(h.login.verifyLogin(h.id, "5678")).rejects.toMatchObject({
      reason: "stale_session",
    });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  test("duplicate verification and late success after cancellation cannot commit credentials", async () => {
    const h = await challenge();
    const verified =
      deferred<Awaited<ReturnType<MiCloud["submitSecurityCode"]>>>();
    const submit = spyOn(
      MiCloud.prototype,
      "submitSecurityCode",
    ).mockImplementation(() => verified.promise);
    const task = h.login.verifyLogin(h.id, "1234");
    await expect(h.login.verifyLogin(h.id, "1234")).rejects.toMatchObject({
      reason: "stale_session",
    });
    h.login.cancel(h.id);
    verified.resolve({ status: "authenticated" });
    await task;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.login.state.status).toBe("cancelled");
  });

  test("adoption transfers client ownership and subsequent attempt cleanup cannot dispose it", async () => {
    const h = await challenge();
    const dispose = spyOn(MiCloud.prototype, "dispose");
    dispose.mockClear();
    spyOn(MiCloud.prototype, "submitSecurityCode").mockResolvedValue({
      status: "authenticated",
    });
    h.commit.mockImplementation(async (candidate) => {
      h.login.prepareCommit(candidate);
      h.login.adopt(candidate);
    });
    await h.login.verifyLogin(h.id, "1234");
    expect(h.login.state.status).toBe("completed");
    h.login.dispose();
    expect(dispose).not.toHaveBeenCalled();
    // The account owner, rather than the login attempt, now releases this client.
    h.commit.mock.calls[0]![0].cloud.dispose();
  });
});
