import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { MiotSpecClient } from "../../../src/mijia/protocols/spec/client";
import { deferred, eventually } from "../../support/async";
import { specInstance, specUrn } from "../../support/protocol-fixtures";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) restore();
});

function mockMetadata(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  const implementation = Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.origin !== "https://miot-spec.org")
        throw new Error(`Unexpected metadata host: ${url.origin}`);
      return Promise.resolve(handler(url, init));
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const request = spyOn(globalThis, "fetch").mockImplementation(implementation);
  restores.push(() => request.mockRestore());
  return request;
}

async function readSpec(
  client = new MiotSpecClient(64 * 1024),
  signal = new AbortController().signal,
) {
  return client.read(
    await client.resolve(
      { model: "test.sensor.contract", spec_type: specUrn },
      signal,
    ),
    signal,
  );
}

describe("public MIoT specifications", () => {
  test("keeps capabilities and value constraints independent of optional translations", async () => {
    const fetch = mockMetadata((url) =>
      url.pathname === "/miot-spec-v2/instance"
        ? Response.json(specInstance())
        : new Response("temporary translation failure", { status: 503 }),
    );
    const result = await readSpec();
    expect(result).toMatchObject({
      urn: specUrn,
      category: "sensor",
      spec: {
        "prop.2.1": {
          readable: true,
          writeable: false,
          notify: false,
          unit: "celsius",
          value_range: [-40, 125, 0.1],
        },
        "prop.2.2": {
          readable: true,
          writeable: true,
          notify: true,
          value_list: [
            { value: 0, name: "Off", description: "Off" },
            { value: 1, name: "On", description: "On" },
          ],
        },
        "action.2.1": {
          readable: false,
          writeable: true,
          notify: false,
          in_params: [{ name: "mode", format: "uint8" }],
        },
        "event.2.1": { readable: false, writeable: false, notify: true },
      },
    });
    expect(JSON.parse(result.spec["event.2.1"]!.format)).toEqual([
      { piid: 1, name: "temperature", format: "float" },
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
      const headers = new Headers(init?.headers);
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("authorization")).toBe(false);
    }
  });

  test("uses non-empty Chinese translations while empty translations retain original meanings", async () => {
    mockMetadata((url) =>
      Response.json(
        url.pathname === "/miot-spec-v2/instance"
          ? specInstance()
          : {
              data: {
                zh_cn: {
                  "service:002": "环境",
                  "service:002:property:001": "温度",
                  "service:002:property:002": " ",
                  "service:002:property:002:valuelist:000": "关闭",
                },
              },
            },
      ),
    );
    const { spec } = await readSpec();
    expect(spec["prop.2.1"]?.description).toBe("环境 温度");
    expect(spec["prop.2.2"]?.description).toBe("环境 Mode");
    expect(spec["prop.2.2"]?.value_list?.[0]).toEqual({
      value: 0,
      name: "Off",
      description: "关闭",
    });
  });

  test.each(["duplicate-property", "event-reference", "action-reference"])(
    "rejects structurally unsafe %s instead of publishing partial capabilities",
    async (fault) => {
      const instance = specInstance();
      const service = instance.services[0]!;
      if (fault === "duplicate-property")
        service.properties.push({ ...service.properties[0]! });
      if (fault === "event-reference") service.events[0]!.arguments = [999];
      if (fault === "action-reference") service.actions[0]!.in = [999];
      const fetch = mockMetadata(() => Response.json(instance));
      await expect(readSpec()).rejects.toMatchObject({
        code: "spec-invalid-response",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  test("coalesces in-flight instance requests without coupling caller cancellation", async () => {
    const response = deferred<Response>();
    let instanceSignal: AbortSignal | undefined;
    let instances = 0;
    const fetch = mockMetadata((url, init) => {
      if (url.pathname === "/miot-spec-v2/instance") {
        instanceSignal = init?.signal ?? undefined;
        return ++instances === 1
          ? response.promise
          : Response.json(specInstance());
      }
      return Response.json({ data: {} });
    });
    const client = new MiotSpecClient(64 * 1024);
    const cancelled = new AbortController();
    const first = readSpec(client, cancelled.signal);
    const second = readSpec(client);
    await eventually(() => fetch.mock.calls.length === 1);
    cancelled.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    expect(instanceSignal?.aborted).toBe(false);
    response.resolve(Response.json(specInstance()));
    expect(await second).toMatchObject({ urn: specUrn });
    expect(instances).toBe(1);
    await readSpec(client);
    expect(instances).toBe(2);
  });

  test("parent cancellation during optional translation still rejects the read", async () => {
    const translationStarted = deferred();
    mockMetadata((url, init) => {
      if (url.pathname === "/miot-spec-v2/instance")
        return Response.json(specInstance());
      translationStarted.resolve();
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        ),
      );
    });
    const controller = new AbortController();
    const pending = readSpec(new MiotSpecClient(64 * 1024), controller.signal);
    await translationStarted.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
});
