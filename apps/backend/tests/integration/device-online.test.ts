import { afterEach, describe, expect, test } from "bun:test";
import {
  runningHousehold,
  householdCatalog,
} from "../support/household-harness";
import { eventually } from "../support/async";

const households: Awaited<ReturnType<typeof runningHousehold>>[] = [];
afterEach(async () => {
  for (const home of households.splice(0)) await home.close();
});
async function household() {
  const home = await runningHousehold();
  households.push(home);
  return home;
}
function devices(home: Awaited<ReturnType<typeof household>>) {
  return Object.values(home.runtime.snapshot().projection.device);
}
function online(home: Awaited<ReturnType<typeof household>>, id: string) {
  return devices(home).find((device) => device.id === id)!.online;
}

describe("设备在线信息的接纳与使用", () => {
  test("首次清单直接给出在线与离线状态；离线设备读取不会请求供应商", async () => {
    const home = await household();
    expect(online(home, "device-a")).toBe(false);
    expect(online(home, "stable")).toBe(true);
    const requests = home.properties.mock.calls.length;
    expect(
      await home.runtime.readProperties(
        home.runtime.epoch,
        [{ did: "device-a", siid: 2, piid: 1 }],
        new AbortController().signal,
      ),
    ).toMatchObject({ items: [{ outcome: "failed", reason: "offline" }] });
    expect(home.properties.mock.calls.length).toBe(requests);
  });

  test("未实测型号的合法上线通知可以恢复读取，随后清单刷新能修正遗漏的离线变化", async () => {
    const home = await household();
    await eventually(() => home.mqtt.transports.length > 0);
    const wire = home.mqtt.transports[0]!;
    wire.connected();
    await eventually(() =>
      wire.subscriptions.some(
        ({ topic }) => topic === "device/device-a/state/#",
      ),
    );
    const topic = "device/device-a/state/online";
    const payload = Buffer.from("{}");
    // A valid report can arrive before the subscription acknowledgement.
    wire.client.emit("message", topic, payload, {
      cmd: "publish",
      topic,
      payload,
      qos: 0,
      dup: false,
      retain: false,
    });
    await eventually(() => online(home, "device-a"));
    expect(
      await home.runtime.readProperties(
        home.runtime.epoch,
        [{ did: "device-a", siid: 2, piid: 1 }],
        new AbortController().signal,
      ),
    ).toMatchObject({ items: [{ outcome: "applied" }] });
    home.catalog.mockResolvedValue(householdCatalog());
    await home.service.loadDevices();
    expect(online(home, "device-a")).toBe(false);
    const requests = home.properties.mock.calls.length;
    expect(
      await home.runtime.readProperties(
        home.runtime.epoch,
        [{ did: "device-a", siid: 2, piid: 1 }],
        new AbortController().signal,
      ),
    ).toMatchObject({ items: [{ outcome: "failed", reason: "offline" }] });
    expect(home.properties.mock.calls.length).toBe(requests);
  });
});
