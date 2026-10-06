import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import {
  applyChanges,
  snapshotSchema,
  stateChangeSchema,
} from "@home-agent/api/household";
import {
  createMijiaHousehold,
  createMijiaSpecificationLoader,
} from "../../../src/mijia/household";
import type { HouseholdRuntime } from "../../../src/household/runtime";
import { householdLimits } from "../../../src/household/config";
import { MijiaService } from "../../../src/mijia/service";
import { createMijiaRoutes } from "../../../src/mijia/routes";
import { MijiaError } from "../../../src/mijia/errors";
import { MiCloud } from "../../../src/mijia/protocols/micloud";
import { MiotSpecClient } from "../../../src/mijia/protocols/spec/client";
import {
  credentialStore,
  homeSelectionStore,
} from "../../support/account-fixtures";
import { deferred, nextTurn } from "../../support/async";

const runtimes: HouseholdRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  mock.restore();
  jest.useRealTimers();
});

function harness() {
  const service = new MijiaService({
    credentialStore: credentialStore(),
    homeSelectionStore: homeSelectionStore(),
    readGo2rtcUrl: async () => {
      throw new Error("No media configuration in HTTP fixture");
    },
  });
  const runtime = createMijiaHousehold(
    service,
    undefined,
    createMijiaSpecificationLoader(
      new MiotSpecClient(householdLimits.specificationResponseBytes),
    ),
  );
  runtimes.push(runtime);
  runtime.start();
  const app = new Hono().route(
    "/api/mijia",
    createMijiaRoutes(4000, runtime, service),
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

  test.each(["/events"])(
    "HEAD %s leaves the stream capacity available for GET",
    async (path) => {
      const h = harness();
      await nextTurn();
      const snapshot = spyOn(h.runtime, "snapshot");
      const subscribe = spyOn(h.runtime, "subscribe");
      const heads = await Promise.all(
        Array.from({ length: 32 }, () => h.request(path, { method: "HEAD" })),
      );
      for (const response of heads) {
        expect(response.status).toBe(200);
        expect(response.body).toBeNull();
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-accel-buffering")).toBe("no");
      }
      expect(snapshot).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();

      const response = await h.request(path);
      const reader = response.body?.getReader();
      try {
        expect(response.status).toBe(200);
        const first = await reader?.read();
        expect(new TextDecoder().decode(first?.value)).toStartWith(
          "event: snapshot\n",
        );
      } finally {
        await reader?.cancel();
        reader?.releaseLock();
      }
    },
  );

  test("GET events enforces 16 connections and cancellation immediately returns one slot", async () => {
    const h = harness();
    const responses = await Promise.all(
      Array.from({ length: 16 }, () => h.request("/events")),
    );
    try {
      expect(responses.every((response) => response.status === 200)).toBe(true);
      const full = await h.request("/events");
      expect(full.status).toBe(503);
      expect(full.headers.get("retry-after")).toBe("30");
      await responses[0]!.body!.cancel();
      const replacement = await h.request("/events");
      responses.push(replacement);
      expect(replacement.status).toBe(200);
      await responses[0]!.body!.cancel();
      expect((await h.request("/events")).status).toBe(503);
    } finally {
      await Promise.all(responses.map((response) => response.body?.cancel()));
    }
  });

  test("the shared state change frame replays a committed version for every subscriber", async () => {
    const h = harness();
    const qr = deferred<Awaited<ReturnType<MiCloud["createLogin"]>>>();
    spyOn(MiCloud.prototype, "createLogin").mockImplementation(
      () => qr.promise,
    );
    const responses = await Promise.all([
      h.request("/events"),
      h.request("/events"),
    ]);
    const readers = responses.map((response) => response.body!.getReader());
    const decoder = new TextDecoder();
    try {
      const initial = await Promise.all(
        readers.map(async (reader) =>
          decoder.decode((await reader.read()).value),
        ),
      );
      expect(initial[0]).toBe(initial[1]);
      const snapshot = snapshotSchema.parse(
        JSON.parse(initial[0]!.split("\ndata: ")[1]!),
      );

      const receipt = await h.request("/login", { method: "POST" });
      const frames = await Promise.all(
        readers.map(async (reader) =>
          decoder.decode((await reader.read()).value),
        ),
      );
      expect(frames[0]).toBe(frames[1]);
      expect(frames[0]).toStartWith("event: state_change\n");
      const change = stateChangeSchema.parse(
        JSON.parse(frames[0]!.split("\ndata: ")[1]!),
      );
      expect(await receipt.json()).toEqual({
        state_version: {
          scope_epoch: change.scope_epoch,
          sequence: change.sequence,
        },
      });
      expect(applyChanges(snapshot.projection, change)).toEqual(
        h.runtime.snapshot().projection,
      );
    } finally {
      await Promise.all(readers.map((reader) => reader.cancel()));
      for (const reader of readers) reader.releaseLock();
      h.service.cancelLogin(h.service.loginPublic().id!);
      qr.resolve({
        qrImage: "data:image/png;base64,dGVzdA==",
        expiresAt: Date.now() + 60_000,
        pollIntervalMs: 2_000,
      });
      await nextTurn();
    }
  });

  test("blocked event writers detach at their deadline while a reading client keeps receiving", async () => {
    jest.useFakeTimers();
    const h = harness();
    const detach = mock(() => {});
    const subscribe = h.runtime.subscribe.bind(h.runtime);
    spyOn(h.runtime, "subscribe").mockImplementation((listener) => {
      const remove = subscribe(listener);
      return () => {
        remove();
        detach();
      };
    });
    const slow = await Promise.all(
      Array.from({ length: 15 }, () => h.request("/events")),
    );
    const healthy = await h.request("/events");
    const reader = healthy.body!.getReader();
    const decoder = new TextDecoder();
    try {
      expect(decoder.decode((await reader.read()).value)).toStartWith(
        "event: snapshot\n",
      );
      await nextTurn();
      expect((await h.request("/events")).status).toBe(503);
      const heartbeat = reader.read();
      // Hono buffers the initial snapshot; the next write blocks only slow readers.
      jest.advanceTimersByTime(householdLimits.heartbeatMs);
      expect(decoder.decode((await heartbeat).value)).toStartWith(
        "event: heartbeat\n",
      );
      await nextTurn();
      jest.advanceTimersByTime(householdLimits.writeTimeoutMs - 1);
      await nextTurn();
      expect(detach).not.toHaveBeenCalled();
      const nextHeartbeat = reader.read();
      jest.advanceTimersByTime(1);
      expect(decoder.decode((await nextHeartbeat).value)).toStartWith(
        "event: heartbeat\n",
      );
      await nextTurn();
      expect(detach).toHaveBeenCalledTimes(15);
      const replacement = await h.request("/events");
      slow.push(replacement);
      expect(replacement.status).toBe(200);
    } finally {
      await reader.cancel();
      reader.releaseLock();
      await Promise.all(slow.map((response) => response.body?.cancel()));
    }
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
    const select = spyOn(h.service, "bindHome");
    const refresh = spyOn(h.service, "loadDevices");
    for (const [path, init] of [
      [
        "/scope/homes",
        json("PUT", { scope_epoch: crypto.randomUUID(), home_id: "home-a" }),
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
});
