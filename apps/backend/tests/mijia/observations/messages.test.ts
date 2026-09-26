import { describe, expect, test } from "bun:test";
import {
  decodePush,
  directoryTopics,
  pushObservations,
  subscribableDevice,
} from "../../../src/mijia/protocols/miot/messages";

const topic = "device/123/up/properties_changed";
const payload = (params: unknown) =>
  Buffer.from(JSON.stringify({ method: "properties_changed", params }));

describe("MIoT push identity and evidence", () => {
  test.each([false, 0, "", null, 21.5])("keeps explicit scalar %j", (value) => {
    expect(
      decodePush(topic, payload({ did: 123, siid: 2, piid: 1, value })),
    ).toEqual([{ kind: "property", did: "123", siid: 2, piid: 1, value }]);
  });

  test("rejects foreign device identity for the whole envelope", () => {
    expect(
      decodePush(
        topic,
        payload([
          { did: "123", siid: 2, piid: 1, value: true },
          { did: "456", siid: 2, piid: 2, value: false },
        ]),
      ),
    ).toEqual([]);
    expect(
      decodePush(`${topic}/2/1`, payload({ siid: 2, piid: 2, value: 1 })),
    ).toEqual([]);
  });

  test("keeps valid array entries without inventing missing values or coercing addresses", () => {
    expect(
      decodePush(
        topic,
        payload([
          { siid: 2, piid: 1 },
          { siid: 2, piid: 2, value: {} },
          { siid: "2", piid: 3, value: 1 },
          { siid: 2, piid: 4, value: null },
          null,
        ]),
      ),
    ).toEqual([
      { kind: "property", did: "123", siid: 2, piid: 4, value: null },
    ]);
  });

  test.each([
    [topic, Buffer.from("not JSON")],
    [topic, Buffer.from('{"method":"event_occured","params":[]}')],
    ["device/123/state/online/extra", Buffer.from("")],
    ["device/123/state/unknown", Buffer.from("")],
    [`${topic}/2`, payload({ siid: 2, piid: 1, value: true })],
  ])("rejects unsupported or malformed message on %s", (address, body) => {
    expect(decodePush(address, body)).toEqual([]);
  });

  test("directory events invalidate only; opaque payload cannot change public fields", () => {
    expect(
      decodePush(
        "device/123/g_op/rename",
        Buffer.from('{"name":"forged","token":"secret"}'),
      ),
    ).toEqual([
      { kind: "directory", did: "123", topic: "device/123/g_op/rename" },
    ]);
    expect(
      decodePush("device/123/state/offline", Buffer.from("opaque")),
    ).toEqual([{ kind: "online", did: "123", online: false }]);
  });

  test("retained means baseline; duplicate values remain separate observations without fabricated device time", () => {
    const body = payload({ siid: 2, piid: 1, value: 42 });
    const live = [
      ...pushObservations(topic, body, false, "source", "generation"),
      ...pushObservations(topic, body, false, "source", "generation"),
    ];
    expect(live).toHaveLength(2);
    for (const event of live)
      expect(event).toMatchObject({
        source_id: "source",
        collection_generation: "generation",
        delivery_kind: "live",
        observed_at: null,
        source_event_id: null,
        source_sequence: null,
      });
    expect(
      pushObservations(topic, body, true, "source", "generation")[0]
        ?.delivery_kind,
    ).toBe("baseline");
  });

  test("invalid identifiers cannot broaden MQTT subscriptions and directory devices are deduplicated", () => {
    for (const did of ["", "a/b", "a#", "+", "a b", "a\0b"])
      expect(subscribableDevice(did)).toBe(false);
    expect(directoryTopics("user", ["123", "123", "a/#"])).toEqual([
      "user/user/g_op/bind",
      "user/user/g_op/unbind",
      "device/123/g_op/rename",
      "device/123/g_op/hr_change",
    ]);
  });
});
