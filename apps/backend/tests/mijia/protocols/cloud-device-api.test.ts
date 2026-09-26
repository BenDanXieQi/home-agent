import { createHash } from "node:crypto";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { cryptRc4 } from "../../../src/mijia/protocols/micloud/rc4";
import { MiCloudTransport } from "../../../src/mijia/protocols/micloud/transport";
import { accountClient } from "../../support/protocol-fixtures";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) restore();
});

// Replace the transport boundary only. The real client prepares encrypted envelopes,
// enforces request budgets, parses responses and joins membership with device details.
function cloudDeviceApi(
  respond: (path: string, data: Record<string, unknown>) => unknown,
) {
  const client = accountClient();
  const request = spyOn(
    MiCloudTransport.prototype,
    "request",
  ).mockImplementation((url, init, _signal, _timeoutMs, onStarted) => {
    if (!(init?.body instanceof URLSearchParams))
      throw new Error("Expected a cloud form body");
    const key = createHash("sha256")
      .update(Buffer.from(init.body.get("ssecurity") ?? "", "base64"))
      .update(Buffer.from(init.body.get("_nonce") ?? "", "base64"))
      .digest();
    const data = z
      .record(z.string(), z.unknown())
      .parse(
        JSON.parse(
          cryptRc4(
            key,
            Buffer.from(init.body.get("data") ?? "", "base64"),
          ).toString("utf8"),
        ),
      );
    onStarted?.("2026-01-02T03:04:05.000Z");
    const result = respond(url.pathname, data);
    return Promise.resolve({
      headers: new Headers(),
      body: Buffer.from(
        cryptRc4(
          key,
          Buffer.from(JSON.stringify({ code: 0, result })),
        ).toString("base64"),
      ),
      url: url.toString(),
    });
  });
  restores.push(() => {
    request.mockRestore();
    client.dispose();
  });
  return { client, request };
}

describe("MiCloud device API boundary", () => {
  test("uses the current account's cache-first protocol and a 30-second single-request budget", async () => {
    const rows = [
      { did: "a", siid: 2, piid: 1, value: false },
      { did: "b", siid: 3, piid: 2, code: -1 },
    ];
    const { client, request } = cloudDeviceApi((path, data) => {
      expect(path).toBe("/app/miotspec/prop/get");
      expect(data).toEqual({
        datasource: 1,
        params: [
          { did: "a", siid: 2, piid: 1 },
          { did: "b", siid: 3, piid: 2 },
        ],
      });
      return rows;
    });
    let startedAt: string | undefined;
    expect(
      await client.getProperties(
        [
          { did: "a", siid: 2, piid: 1 },
          { did: "b", siid: 3, piid: 2 },
        ],
        undefined,
        (at) => {
          startedAt = at;
        },
      ),
    ).toEqual(rows);
    expect(request.mock.calls[0]?.[3]).toBe(30_000);
    expect(startedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  test("invalid and oversized batches never consume transport; empty reads stay local", async () => {
    const { client, request } = cloudDeviceApi(() => []);
    await expect(
      client.getProperties([{ did: "a", siid: 0, piid: 1 }]),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      client.getProperties(
        Array.from({ length: 151 }, (_, index) => ({
          did: "a",
          siid: 2,
          piid: index + 1,
        })),
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(await client.getProperties([])).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  test("rejects an outer-success response whose result is not a property row array", async () => {
    const { client } = cloudDeviceApi(() => ({ did: "a", value: 1 }));
    await expect(
      client.getProperties([{ did: "a", siid: 2, piid: 1 }]),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  test("uses authoritative owned/shared membership, ignores foreign details and overrides detail-supplied locations", async () => {
    const requests: Record<string, unknown>[] = [];
    const { client } = cloudDeviceApi((path, data) => {
      if (path === "/app/v2/homeroom/gethome")
        return {
          homelist: [{ id: "owned", name: "Owned", dids: ["a"], roomlist: [] }],
          share_home_list: [
            {
              id: "shared",
              name: "Shared",
              dids: ["b"],
              roomlist: [{ id: "room-b", name: "Bedroom", dids: ["b"] }],
            },
          ],
        };
      expect(path).toBe("/app/v2/home/device_list_page");
      requests.push(data);
      return requests.length === 1
        ? {
            list: [
              { did: "a", model: "test.sensor", home_id: "forged-home" },
              { did: "foreign", model: "test.sensor" },
            ],
            has_more: true,
            next_start_did: "cursor-a",
          }
        : {
            list: [
              {
                did: "b",
                model: "test.sensor",
                home_id: "forged-home",
                room_id: "forged-room",
              },
            ],
            has_more: false,
          };
    });
    const catalog = await client.getCatalog();
    expect(requests.map((data) => data.dids)).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(requests[1]?.start_did).toBe("cursor-a");
    expect(catalog.devices).toMatchObject([
      { did: "a", home_id: "owned", room_id: null },
      { did: "b", home_id: "shared", room_id: "room-b" },
    ]);
    expect(catalog.devices).toHaveLength(2);
  });

  test("chunks membership details by 150 without losing the final device", async () => {
    const ids = Array.from({ length: 151 }, (_, index) => `device-${index}`);
    const sizes: number[] = [];
    const { client } = cloudDeviceApi((path, data) => {
      if (path === "/app/v2/homeroom/gethome")
        return {
          homelist: [{ id: "home", name: "Home", dids: ids, roomlist: [] }],
        };
      const dids = z.array(z.string()).parse(data.dids);
      sizes.push(dids.length);
      return { list: dids.map((did) => ({ did })) };
    });
    expect(
      (await client.getCatalog()).devices.map((device) => device.did),
    ).toEqual(ids);
    expect(sizes).toEqual([150, 1]);
  });

  test("a repeating detail cursor rejects the full candidate instead of silently truncating", async () => {
    let pages = 0;
    const { client } = cloudDeviceApi((path) => {
      if (path === "/app/v2/homeroom/gethome")
        return {
          homelist: [{ id: "home", name: "Home", dids: ["a"], roomlist: [] }],
        };
      pages++;
      return {
        list: [{ did: "a" }],
        has_more: true,
        next_start_did: "same-cursor",
      };
    });
    await expect(client.getCatalog()).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(pages).toBe(2);
  });

  test("preserves missing membership references for household-scoped completeness validation", async () => {
    const { client } = cloudDeviceApi((path) => {
      if (path === "/app/v2/homeroom/gethome")
        return {
          homelist: [
            { id: "home", name: "Home", dids: ["a", "b"], roomlist: [] },
          ],
        };
      return { list: [{ did: "a" }], has_more: false };
    });
    const catalog = await client.getCatalog();
    expect(catalog.homes[0]?.deviceIds).toEqual(["a", "b"]);
    expect(catalog.devices.map((device) => device.did)).toEqual(["a"]);
  });
});
