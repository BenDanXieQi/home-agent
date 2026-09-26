import { mijiaDeviceSpecSchema } from "@home-agent/api/mijia";
import { MiCloud } from "../../src/mijia/protocols/micloud";
import { savedSessionSchema } from "../../src/mijia/protocols/micloud/session";

export function savedSession(
  overrides: Partial<ReturnType<typeof savedSessionSchema.parse>> = {},
) {
  return savedSessionSchema.parse({
    region: "cn",
    userId: "100001",
    passToken: "test-pass-token",
    ssecurity: Buffer.from("test-security-key").toString("base64"),
    serviceToken: "test-service-token",
    expiresAt: null,
    clientId: "ABCDEF",
    userAgent: "HomeAgentContractTests",
    ...overrides,
  });
}

export function accountClient(
  overrides: Parameters<typeof savedSession>[0] = {},
) {
  return MiCloud.restoreSession(savedSession(overrides));
}

export function preparedSpec(did = "device-1") {
  return mijiaDeviceSpecSchema.parse({
    did,
    name: "Test sensor",
    model: "test.sensor.contract",
    online: false,
    home: "Test home",
    room: "Test room",
    category: "sensor",
    spec: {
      "prop.2.1": {
        description: "Temperature",
        format: "float",
        readable: true,
        writeable: false,
        notify: false,
        type_name: "temperature",
      },
      "prop.2.2": {
        description: "Power",
        format: "bool",
        readable: true,
        writeable: true,
        notify: true,
        type_name: "on",
      },
      "prop.2.3": {
        description: "Write only",
        format: "bool",
        readable: false,
        writeable: true,
        notify: true,
        type_name: "on",
      },
    },
  });
}

export const specUrn =
  "urn:miot-spec-v2:device:sensor:0000A001:test-contract:1";

/** A small protocol document with independent read, notify, action and event semantics. */
export function specInstance() {
  return {
    type: specUrn,
    description: "Sensor",
    services: [
      {
        iid: 2,
        type: "urn:miot-spec-v2:service:environment:0000780A:test:1",
        description: "Environment",
        properties: [
          {
            iid: 1,
            type: "urn:miot-spec-v2:property:temperature:00000020:test:1",
            description: "Temperature",
            format: "float",
            access: ["read"],
            unit: "celsius",
            "value-range": [-40, 125, 0.1],
          },
          {
            iid: 2,
            type: "urn:miot-spec-v2:property:mode:00000008:test:1",
            description: "Mode",
            format: "uint8",
            access: ["read", "write", "notify"],
            "value-list": [
              { value: 0, description: "Off" },
              { value: 1, description: "On" },
            ],
          },
        ],
        actions: [
          {
            iid: 1,
            type: "urn:miot-spec-v2:action:set-mode:00002801:test:1",
            description: "Set mode",
            in: [2],
            out: [],
          },
        ],
        events: [
          {
            iid: 1,
            type: "urn:miot-spec-v2:event:temperature-alarm:00005001:test:1",
            description: "Temperature alarm",
            arguments: [1],
          },
        ],
      },
    ],
  };
}
