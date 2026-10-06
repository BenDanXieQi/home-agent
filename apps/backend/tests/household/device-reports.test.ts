import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { deviceCapabilitySchema } from "@home-agent/api/devices";
import { selectRoomFacts } from "@home-agent/api/household";
import { householdObservationSchema } from "@home-agent/api/observations";
import {
  configureCollection,
  propertyPolicy,
} from "../../src/household/collection-policy";
import type { FactInput } from "../../src/household/observations";
import { publicDirectory } from "../../src/household/directory";
import { runningMachine } from "../support/household-machine";

const actors: ReturnType<typeof runningMachine>["actor"][] = [];
let tick = 0;
let clock: ReturnType<typeof spyOn<typeof performance, "now">> | undefined;
afterEach(() => {
  for (const actor of actors.splice(0)) actor.stop();
  clock?.mockRestore();
  clock = undefined;
});

// The vendor boundary supplies reports; the real household actor owns their state.
function household({ configured = true, knownSpec = true } = {}) {
  tick = 0;
  clock = spyOn(performance, "now").mockImplementation(() => tick);
  const { actor } = runningMachine();
  actors.push(actor);
  const device = Object.values(
    actor.getSnapshot().context.projection.device,
  )[0]!;
  const policy = configureCollection({
    properties: configured
      ? [
          {
            model: device.model,
            spec_id: null,
            siid: 2,
            piid: 1,
            read: true,
            verified_push: true,
            freshness: { mode: "ttl", max_age_ms: 1000 },
          },
        ]
      : [],
  });
  const definition = {
    device,
    siid: 2,
    piid: 1,
    capability: knownSpec
      ? deviceCapabilitySchema.parse({
          description: "开关",
          type_name: "on",
          service_type_name: "light",
          format: "bool",
          readable: true,
          writeable: true,
          notify: true,
        })
      : undefined,
    policy: propertyPolicy(policy, device.model, device.spec_id, 2, 1),
    policy_version: policy.version,
  };
  function commit(input: FactInput) {
    actor.send({
      type: "facts",
      scope_epoch: actor.getSnapshot().context.scope_epoch,
      input,
    });
    return actor.getSnapshot().context.fact_result!;
  }
  function at(milliseconds: number) {
    tick = milliseconds;
  }
  function timestamp(milliseconds = tick) {
    return new Date(Date.UTC(2026, 9, 4) + milliseconds).toISOString();
  }
  function observe(report: Record<string, unknown>, receivedTick = tick) {
    return commit({
      kind: "observe",
      event: householdObservationSchema.parse({
        source_id: "test-source",
        collection_generation: "connection-1",
        did: device.id,
        received_at: timestamp(receivedTick),
        ...report,
      }),
      definition,
      observation_id: crypto.randomUUID(),
      tick: receivedTick,
    });
  }
  function connect(generation = "connection-1") {
    observe({
      kind: "connection",
      status: "connected",
      reason: null,
      collection_generation: generation,
    });
    observe({
      kind: "subscription",
      channel: "properties",
      status: "confirmed",
      reason: null,
      collection_generation: generation,
    });
  }
  function push(
    value: boolean | number,
    generation = "connection-1",
    receivedTick = tick,
  ) {
    return observe(
      {
        kind: "property",
        siid: 2,
        piid: 1,
        value,
        delivery_kind: "live",
        observed_at: null,
        packet_bytes: 32,
        collection_generation: generation,
      },
      receivedTick,
    );
  }
  function read(value: boolean | number) {
    return observe({
      kind: "read",
      siid: 2,
      piid: 1,
      value,
      observed_at: null,
      read_started_at: timestamp(),
    });
  }
  function snapshot() {
    const { scope_epoch, sequence, projection } = actor.getSnapshot().context;
    return { scope_epoch, sequence, projection };
  }
  function view() {
    return selectRoomFacts(snapshot(), { room_id: null });
  }
  function fact() {
    return view().properties[0]!;
  }
  function expire() {
    return commit({ kind: "expire", tick, at: timestamp() });
  }
  function refreshOnline(online: boolean) {
    const current = snapshot();
    actor.send({
      type: "directory",
      scope_epoch: current.scope_epoch,
      projection: {
        ...current.projection,
        ...publicDirectory(
          {
            accountId: device.account_id,
            homeId: device.home_id,
            homes: [
              { id: device.home_id!, name: "Home A", shared: false, rooms: [] },
            ],
            devices: [{ ...device, online, spec_type: null }],
          },
          current.projection,
        ),
      },
    });
  }
  commit({
    kind: "configure",
    definitions: [definition],
    supported: [device.id],
    policy_version: policy.version,
  });
  connect();
  return {
    at,
    observe,
    connect,
    push,
    read,
    view,
    fact,
    expire,
    refreshOnline,
  };
}

describe("设备报告的业务使用条件", () => {
  test("缺值不代表关闭；云缓存的关闭报告仍是待确认值", () => {
    const home = household();
    expect(home.fact().has_value).toBe(false);
    expect(home.view().coverage.missing).toBe(1);

    home.read(false);
    expect(home.fact()).toMatchObject({
      has_value: true,
      value: false,
      reason: "cloud_cache",
    });
    expect(home.view().coverage).toMatchObject({ missing: 0, valid: 0 });
  });

  test("迟到云缓存不能覆盖实时值、制造变化或延长实时报告的有效期", () => {
    const home = household();
    home.push(false);
    home.at(100);
    home.push(true);
    const current = home.fact();
    home.at(900);
    home.read(false);
    expect(home.fact()).toMatchObject({
      value: true,
      reason: "current",
      evidence: current.evidence,
      expires_at: current.expires_at,
      last_change_at: current.last_change_at,
      read_candidate: { value: false },
    });
    home.at(1100);
    home.expire();
    expect(home.fact().reason).toBe("expired");
  });

  test("同值续报维持有效状态，但不制造变化", () => {
    const home = household();
    home.push(false);
    const firstReport = home.fact().last_report_at;
    home.at(900);
    home.push(false);
    expect(home.fact().last_report_at).not.toBe(firstReport);
    expect(home.fact().last_change_at).toBeNull();
    home.at(1000);
    home.expire();
    home.at(1900);
    home.expire();
    expect(home.fact()).toMatchObject({
      value: false,
      has_value: true,
      reason: "expired",
    });
  });

  test("断连后重连与订阅确认不能复活旧值，恢复首报只建立比较起点", () => {
    const home = household();
    home.push(false);
    const evidence = home.fact().evidence;
    home.at(100);
    home.observe({ kind: "connection", status: "closed", reason: "network" });
    expect(home.view().devices[0]?.online).toBe(true);
    expect(home.fact()).toMatchObject({
      value: false,
      has_value: true,
      reason: "disconnected",
      evidence,
    });
    expect(home.view().coverage.valid).toBe(0);
    home.connect("connection-2");
    home.push(true, "connection-1");
    expect(home.fact().value).toBe(false);
    home.push(true, "connection-2");
    expect(home.fact()).toMatchObject({
      value: true,
      reason: "current",
    });
    home.at(200);
    home.push(false, "connection-2");
  });

  test("过期值仍可查看", () => {
    const home = household();
    home.push(false);
    home.at(1000);
    home.expire();
    expect(home.fact()).toMatchObject({
      has_value: true,
      value: false,
      reason: "expired",
    });
    home.push(true);
    home.at(1100);
    home.push(false);
  });

  test("积压中已超期的报告不能重新成为当前有效状态", () => {
    const home = household();
    home.push(false);
    home.at(2000);
    home.push(true, "connection-1", 500);
    expect(home.fact()).toMatchObject({
      value: true,
      reason: "expired",
    });
  });

  test("未配置有效期的实时报告保持待确认", () => {
    const home = household({ configured: false });
    home.push(false);
    home.push(true);
    expect(home.fact()).toMatchObject({
      value: true,
      reason: "unverified",
    });
    expect(home.view().coverage.valid).toBe(0);
  });

  test("规格未知的原值可查看，但不能猜作灯光状态", () => {
    const home = household({ knownSpec: false });
    home.push(false);
    expect(home.fact()).toMatchObject({
      has_value: true,
      value: false,
      reason: "spec_unknown",
    });
  });

  test("非法读取不损害已有实时值；冲突的实时上报则撤销旧值的使用资格", () => {
    const home = household();
    home.push(false);
    home.at(100);
    expect(home.read(1).receipt).toMatchObject({
      outcome: "failed",
      reason: "invalid_value",
    });
    expect(home.fact()).toMatchObject({
      value: false,
      reason: "current",
    });
    home.push(1);
    expect(home.fact()).toMatchObject({
      value: false,
      reason: "invalid_value",
    });
    home.push(true);
  });

  test("清单刷新确认离线撤销旧报告的使用资格，上线后仍须等待新的实时报告", () => {
    const home = household();
    home.push(false);
    home.refreshOnline(false);
    expect(home.view().devices[0]?.online).toBe(false);
    expect(home.fact()).toMatchObject({
      value: false,
      reason: "offline",
    });
    home.refreshOnline(true);
    expect(home.view().devices[0]?.online).toBe(true);
    home.push(true);
  });

  test("合法上下线通知不依赖型号验证名单，旧连接通知不能覆盖当前设备状态", () => {
    const home = household();
    home.push(false);
    const notify = (online: boolean, collection_generation = "connection-1") =>
      home.observe({
        kind: "online",
        online,
        delivery_kind: "live",
        observed_at: null,
        packet_bytes: 32,
        collection_generation,
      });
    notify(false);
    expect(home.view().devices[0]?.online).toBe(false);
    home.connect("connection-2");
    notify(true);
    expect(home.view().devices[0]?.online).toBe(false);
    notify(true, "connection-2");
    expect(home.view().devices[0]?.online).toBe(true);
    home.push(true, "connection-2");
  });
});
