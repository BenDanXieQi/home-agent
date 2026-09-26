import { spyOn } from "bun:test";
import { PassThrough } from "node:stream";
import * as mqtt from "mqtt";
import type { ClientSubscribeCallback, PacketCallback } from "mqtt";
import { oauthSession } from "../../support/account-fixtures";

export const oauth = oauthSession();

/** Only the vendor SDK boundary is replaced; both observation owners remain real. */
export function mqttTransport() {
  const client = new mqtt.MqttClient(() => new PassThrough(), {
    manualConnect: true,
  });
  const subscriptions: {
    topic: string;
    ack: ClientSubscribeCallback;
  }[] = [];
  const unsubscriptions: { topic: string; ack: PacketCallback }[] = [];
  const connect = spyOn(client, "connect").mockReturnValue(client);
  const end = spyOn(client, "endAsync").mockResolvedValue();
  const subscribe = spyOn(client, "subscribe").mockImplementation(
    (
      topic: Parameters<typeof client.subscribe>[0],
      options?:
        | Parameters<typeof client.subscribe>[1]
        | ClientSubscribeCallback,
      callback?: ClientSubscribeCallback,
    ) => {
      if (
        typeof topic !== "string" ||
        !callback ||
        typeof options === "function"
      )
        throw new Error("Unexpected subscribe boundary");
      subscriptions.push({ topic, ack: callback });
      return client;
    },
  );
  const unsubscribe = spyOn(client, "unsubscribe").mockImplementation(
    (
      topic: Parameters<typeof client.unsubscribe>[0],
      options?: Parameters<typeof client.unsubscribe>[1] | PacketCallback,
      callback?: PacketCallback,
    ) => {
      const ack = typeof options === "function" ? options : callback;
      if (typeof topic !== "string" || !ack)
        throw new Error("Unexpected unsubscribe boundary");
      unsubscriptions.push({ topic, ack });
      return client;
    },
  );
  return {
    client,
    subscriptions,
    unsubscriptions,
    connect,
    end,
    connected: () =>
      client.emit("connect", {
        cmd: "connack",
        sessionPresent: false,
        reasonCode: 0,
      }),
    ack(index: number, code = 2) {
      const request = subscriptions[index];
      if (!request) throw new Error("Missing subscription");
      request.ack(null, [{ topic: request.topic, qos: 2 }], {
        cmd: "suback",
        messageId: index + 1,
        granted: [code],
      });
    },
    ackUnsubscribe(index: number, code = 0) {
      const request = unsubscriptions[index];
      if (!request) throw new Error("Missing unsubscription");
      request.ack(undefined, {
        cmd: "unsuback",
        messageId: index + 1,
        granted: [code],
      });
    },
    publish(value: unknown = true, did = "123") {
      const topic = `device/${did}/up/properties_changed`;
      client.emit(
        "message",
        topic,
        Buffer.from(
          JSON.stringify({
            method: "properties_changed",
            params: { did, siid: 2, piid: 1, value },
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
    },
    restore() {
      connect.mockRestore();
      end.mockRestore();
      subscribe.mockRestore();
      unsubscribe.mockRestore();
    },
  };
}

export function interceptMqtt() {
  const transports: ReturnType<typeof mqttTransport>[] = [];
  const factory = spyOn(mqtt, "connect").mockImplementation(() => {
    const transport = mqttTransport();
    transports.push(transport);
    return transport.client;
  });
  return {
    transports,
    factory,
    restore() {
      factory.mockRestore();
      for (const transport of transports) transport.restore();
    },
  };
}

export async function flushMicrotasks() {
  // Ownership transitions use nested operation spans and finally continuations.
  for (let step = 0; step < 20; step++) await Promise.resolve();
}
