import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { HouseholdRuntime } from "../../../src/household/runtime";
import { DevicePushLogs } from "../../../src/household/device-logs";
import { MijiaService } from "../../../src/mijia/service";
import { createMijiaRoutes } from "../../../src/mijia/routes";
import { MijiaError } from "../../../src/mijia/errors";
import { MiCloud } from "../../../src/mijia/protocols/micloud";
import {
  credentialStore,
  homeSelectionStore,
} from "../../support/account-fixtures";
import { deferred, eventually, nextTurn } from "../../support/async";

const runtimes: HouseholdRuntime[] = [];
const logStores: DevicePushLogs[] = [];
const logDirectories: string[] = [];
afterEach(async () => {
  for (const logs of logStores.splice(0)) {
    await logs.ready;
    await logs.stop();
  }
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of logDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
  mock.restore();
});

function harness() {
  const service = new MijiaService({
    credentialStore: credentialStore(),
    homeSelectionStore: homeSelectionStore(),
    readGo2rtcUrl: async () => {
      throw new Error("No media configuration in HTTP fixture");
    },
  });
  const runtime = new HouseholdRuntime(service, undefined);
  runtimes.push(runtime);
  runtime.start();
  const directory = mkdtempSync(join(tmpdir(), "home-agent-routes-"));
  logDirectories.push(directory);
  const logs = new DevicePushLogs(runtime, directory);
  logStores.push(logs);
  const app = new Hono().route(
    "/api/mijia",
    createMijiaRoutes(4000, runtime, logs),
  );
  async function request(
    path: string,
    init: RequestInit = {},
    address = "127.0.0.1",
  ) {
    return app.request(
      `http://localhost:4000/api/mijia${path}`,
      {
        ...init,
        headers: {
          host: "localhost:4000",
          ...Object.fromEntries(new Headers(init.headers)),
        },
      },
      { requestIP: () => ({ address, port: 50000, family: "IPv4" }) },
    );
  }
  return { app, service, runtime, request };
}

function json(method: string, body: unknown) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("Mijia HTTP contract (real Hono app.request)", () => {
  test("state is a no-store public snapshot and reading it never starts vendor discovery", async () => {
    const h = harness();
    const catalog = spyOn(MiCloud.prototype, "getCatalog");
    const response = await h.request("/state");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(catalog).not.toHaveBeenCalled();
  });

  test.each([
    [
      "remote peer with forged forwarded headers",
      "192.0.2.10",
      { "x-forwarded-for": "127.0.0.1" },
    ],
    ["untrusted origin", "127.0.0.1", { origin: "https://attacker.invalid" }],
    ["untrusted Host", "127.0.0.1", { host: "attacker.invalid:4000" }],
    ["wrong loopback port", "127.0.0.1", { host: "localhost:8080" }],
  ])("rejects %s before starting login", async (_name, peer, headers) => {
    const h = harness();
    const start = spyOn(h.service, "startLogin");
    const response = await h.request(
      "/login",
      { method: "POST", headers },
      peer,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "local_access_required",
    });
    expect(start).not.toHaveBeenCalled();
  });

  test.each(["http://localhost:5173", "http://127.0.0.1:4000"])(
    "allows trusted local origin %s",
    async (origin) => {
      const response = await harness().request("/state", {
        headers: { origin },
      });
      expect(response.status).toBe(200);
    },
  );

  test("login returns an accepted version and cancellation invalidates its material endpoint", async () => {
    const h = harness();
    const qr = deferred<Awaited<ReturnType<MiCloud["createLogin"]>>>();
    spyOn(MiCloud.prototype, "createLogin").mockImplementation(
      () => qr.promise,
    );
    const response = await h.request("/login", { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      state_version: h.runtime.version(),
    });
    const id = h.service.loginPublic().id!;
    const material = await h.request(`/login/${id}/material`);
    expect(material.headers.get("cache-control")).toBe("no-store");
    expect(await material.json()).toMatchObject({ id, qr_image_url: null });
    await h.request(`/login/${id}`, { method: "DELETE" });
    const stale = await h.request(`/login/${id}/material`);
    expect(stale.status).toBe(409);
    qr.resolve({
      qrImage: "data:image/png;base64,dGVzdA==",
      expiresAt: Date.now() + 60_000,
      pollIntervalMs: 2_000,
    });
    await nextTurn();
  });

  test("an obsolete epoch is rejected before household selection or refresh work", async () => {
    const h = harness();
    const select = spyOn(h.service, "selectHome");
    const refresh = spyOn(h.service, "loadDevices");
    for (const [path, init] of [
      [
        "/scope/homes",
        json("PUT", { scope_epoch: crypto.randomUUID(), home_id: null }),
      ],
      [
        "/devices/refresh",
        json("POST", { scope_epoch: crypto.randomUUID(), target: "all" }),
      ],
    ] as const) {
      const response = await h.request(path, init);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "mijia_stale_session",
      });
    }
    expect(select).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  test("an oversized SDP request is rejected before negotiation", async () => {
    const h = harness();
    const offer = spyOn(h.service, "offer");
    const response = await h.request(
      "/playback/viewer",
      json("PUT", { revision: crypto.randomUUID(), sdp: "x".repeat(70_001) }),
    );
    expect(response.status).toBe(413);
    expect(offer).not.toHaveBeenCalled();
  });

  test("logout cleanup failure is an error response, never a successful command version", async () => {
    const h = harness();
    spyOn(h.service, "logout").mockRejectedValue(
      new MijiaError("go2rtc_cleanup"),
    );
    const response = await h.request("/session", { method: "DELETE" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json();
    expect(body).toMatchObject({ code: "mijia_go2rtc_cleanup" });
    expect(body).not.toHaveProperty("state_version");
  });

  test("viewer DELETE waits for cleanup and returns a genuinely empty 204", async () => {
    const h = harness();
    const released = deferred();
    const release = spyOn(h.service, "release").mockImplementation(
      () => released.promise,
    );
    let completed = false;
    const pending = h
      .request("/playback/viewer", { method: "DELETE" })
      .then((response) => {
        completed = true;
        return response;
      });
    await eventually(() => release.mock.calls.length === 1);
    expect(completed).toBe(false);
    released.resolve();
    const response = await pending;
    expect(release).toHaveBeenCalledWith("viewer");
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});
