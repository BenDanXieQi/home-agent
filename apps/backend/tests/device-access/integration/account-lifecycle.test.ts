import { afterEach, describe, expect, test } from "bun:test";
import { CredentialStoreError } from "../../../src/credentials/store";
import { accountSessionSchema } from "../../../src/mijia/account/session";
import type { MiCloud } from "../../../src/mijia/protocols/micloud";
import { deferred, eventually, nextTurn } from "../../support/async";
import {
  holdCredentialWrite,
  householdCatalog,
  loginHttp,
  runningHousehold,
} from "../../support/household-harness";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
const logins: ReturnType<typeof loginHttp>[] = [];
const releases: (() => void)[] = [];
const accountA = '["cn","100001"]';
const accountB = '["cn","200002"]';
const property = (did: string) => ({ did, siid: 2, piid: 1 });
const signal = () => new AbortController().signal;

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  try {
    for (const h of households.splice(0)) await h.close();
  } finally {
    for (const login of logins.splice(0)) login.restore();
  }
});

async function replacementHousehold() {
  const catalogA = householdCatalog();
  catalogA.devices.push({
    ...catalogA.devices[0]!,
    did: "camera-a",
    model: "test.camera.single",
  });
  catalogA.homes[0]!.deviceIds.push("camera-a");
  const catalogB = householdCatalog();
  catalogB.homes = catalogB.homes.filter((home) => home.id === "home-b");
  catalogB.devices = catalogB.devices.filter(
    (device) => device.did === "device-b",
  );
  const h = await runningHousehold(catalogA);
  households.push(h);
  h.catalog.mockImplementation(function (this: MiCloud) {
    return Promise.resolve(
      this.getCredentials().userId === "200002" ? catalogB : catalogA,
    );
  });
  h.homes.read.mockImplementation((account) =>
    Promise.resolve({ homeId: account === accountB ? "home-b" : "home-a" }),
  );
  logins.push(loginHttp(h, { userId: "200002" }));
  await eventually(() => h.service.snapshot().binding.status === "ready");
  return h;
}

async function storedUser(h: Awaited<ReturnType<typeof runningHousehold>>) {
  const stored = await h.store.read("mijia");
  return stored
    ? accountSessionSchema.parse(stored.value).micloud.userId
    : null;
}

function readyForB(h: Awaited<ReturnType<typeof runningHousehold>>) {
  return eventually(
    () =>
      h.service.identity() === accountB &&
      h.runtime.ready &&
      Object.values(h.runtime.snapshot().projection.spec).some(
        (spec) => spec.status === "ready",
      ),
  );
}

function beginReplacement(h: Awaited<ReturnType<typeof runningHousehold>>) {
  const writing = holdCredentialWrite(h);
  releases.push(writing.release);
  h.service.startLogin();
  return writing;
}

function publishProperty(
  transport: Awaited<
    ReturnType<typeof runningHousehold>
  >["mqtt"]["transports"][number],
  value: number,
) {
  const topic = "device/device-a/up/properties_changed";
  transport.client.emit(
    "message",
    topic,
    Buffer.from(
      JSON.stringify({
        method: "properties_changed",
        params: { ...property("device-a"), value },
      }),
    ),
    {
      cmd: "publish",
      topic,
      payload: Buffer.alloc(0),
      qos: 0,
      dup: false,
      retain: false,
    },
  );
}

describe("durable account replacement races", () => {
  test("B becomes usable only after persistence, then A's read, push and viewer lose authority together", async () => {
    const h = await replacementHousehold();
    expect(
      await h.service.readProperties([property("device-a")], signal()),
    ).toMatchObject([{ status: "success", value: 21 }]);
    const events: Parameters<
      Parameters<typeof h.service.observeDevices>[1]
    >[0][] = [];
    await h.service.observeDevices(
      ["device-a"],
      (event) => events.push(event),
      signal(),
    );
    const oldTransport = h.mqtt.transports.at(-1)!;
    oldTransport.connected();
    publishProperty(oldTransport, 1);
    expect(events.filter((event) => event.kind === "property")).toHaveLength(1);

    const oldRevision = h.service.snapshot().revision;
    const viewer = h.runtime.reservePlayback(
      h.runtime.epoch,
      oldRevision,
      "camera-a",
      1,
    );
    await h.service.offer(oldRevision, viewer.id, "fixture-offer", signal());
    expect(h.service.playbackSnapshot(viewer.id).phase).toBe("active");
    const entered = deferred<AbortSignal | undefined>();
    const lateResponse = deferred<Awaited<ReturnType<typeof h.properties>>>();
    releases.push(() =>
      lateResponse.resolve([{ ...property("device-a"), value: 88 }]),
    );
    h.properties.mockImplementationOnce((_batch, requestSignal) => {
      entered.resolve(requestSignal);
      return lateResponse.promise;
    });
    const oldRead = h.service
      .readProperties([property("device-a")], signal())
      .then(
        (observations) => ({ accepted: true as const, observations }),
        (error: unknown) => ({ accepted: false as const, error }),
      );
    const oldReadSignal = await entered.promise;
    const writing = beginReplacement(h);
    await writing.started;
    expect(await storedUser(h)).toBe("100001");
    expect(h.service.identity()).toBe(accountA);
    expect(h.service.playbackSnapshot(viewer.id).phase).toBe("active");
    await expect(
      h.service.readProperties([property("device-b")], signal()),
    ).rejects.toMatchObject({ reason: "device_not_found" });
    publishProperty(oldTransport, 2);
    expect(events.filter((event) => event.kind === "property")).toHaveLength(2);

    writing.release();
    await readyForB(h);
    expect(await storedUser(h)).toBe("200002");
    expect(oldReadSignal?.aborted).toBe(true);
    expect(await oldRead).toMatchObject({ accepted: false });
    publishProperty(oldTransport, 3);
    lateResponse.resolve([{ ...property("device-a"), value: 88 }]);
    await nextTurn();
    expect(events.filter((event) => event.kind === "property")).toHaveLength(2);
    expect(() => h.service.playbackSnapshot(viewer.id)).toThrow();
    expect(() =>
      h.service.offer(oldRevision, viewer.id, "fixture-offer", signal()),
    ).toThrow();
    await eventually(() =>
      h.peer.calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.path === "playback" &&
          call.body.playbackId === viewer.id,
      ),
    );
    expect(
      await h.service.readProperties([property("device-b")], signal()),
    ).toMatchObject([{ status: "success", value: 21 }]);
    await expect(
      h.service.readProperties([property("device-a")], signal()),
    ).rejects.toMatchObject({ reason: "device_not_found" });
  });

  test("cancelling after a credential write starts cannot split the persisted and accepted account", async () => {
    const h = await replacementHousehold();
    const writing = beginReplacement(h);
    await writing.started;
    const attempt = h.service.loginPublic();
    if (!attempt.id) throw new Error("Expected an active login attempt");
    h.service.cancelLogin(attempt.id);
    expect(h.service.identity()).toBe(accountA);
    expect(await storedUser(h)).toBe("100001");
    writing.release();
    await writing.committed;
    await nextTurn();
    expect(await storedUser(h)).toBe("200002");
    expect(h.service.identity()).toBe(accountB);
    await readyForB(h);
    expect(h.service.loginPublic()).toMatchObject({
      id: attempt.id,
      status: "completed",
    });
    expect(
      await h.service.readProperties([property("device-b")], signal()),
    ).toMatchObject([{ status: "success" }]);
  });

  test.each(["succeeds", "fails"] as const)(
    "logout queued behind a credential write stays consistent when deletion %s",
    async (deletion) => {
      const h = await replacementHousehold();
      const writing = beginReplacement(h);
      await writing.started;
      const remove = h.store.remove.getMockImplementation();
      if (!remove)
        throw new Error("Expected credential deletion implementation");
      const ownersAtDelete: ReturnType<typeof h.service.identity>[] = [];
      h.store.remove.mockImplementationOnce(async (...args) => {
        ownersAtDelete.push(h.service.identity());
        if (deletion === "fails") throw new CredentialStoreError();
        await remove(...args);
      });
      const logout = h.runtime.logout().then(
        () => ({ accepted: true as const }),
        (error: unknown) => ({ accepted: false as const, error }),
      );
      await nextTurn();
      expect(h.store.remove).not.toHaveBeenCalled();
      expect(h.service.identity()).toBe(accountA);
      expect(await storedUser(h)).toBe("100001");
      writing.release();
      const result = await logout;
      expect(ownersAtDelete).toEqual([accountB]);
      if (deletion === "succeeds") {
        expect(result).toEqual({ accepted: true });
        expect(await storedUser(h)).toBeNull();
        expect(h.service.identity()).toBeNull();
        expect(h.service.snapshot().account.status).toBe("idle");
        expect(h.runtime.ready).toBe(false);
        expect(h.runtime.snapshot().projection.device).toEqual({});
        expect(
          h.mqtt.transports.every(
            (transport) => transport.end.mock.calls.length === 1,
          ),
        ).toBe(true);
        expect(h.service.snapshot().binding.status).toBe("unbound");
      } else {
        expect(result).toMatchObject({
          accepted: false,
          error: { reason: "credential_storage" },
        });
        await readyForB(h);
        expect(h.service.identity()).toBe(accountB);
        expect(await storedUser(h)).toBe("200002");
        expect(
          await h.service.readProperties([property("device-b")], signal()),
        ).toMatchObject([{ status: "success" }]);
      }
    },
  );
});
