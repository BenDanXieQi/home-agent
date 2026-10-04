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
import {
  buildRoomContext,
  canTrigger,
  roomDependencies,
  roomDependenciesChanged,
} from "../../src/room-analysis/context";
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
            rule_eligible: true,
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
  function context() {
    return buildRoomContext(
      snapshot(),
      null,
      "manual",
      [],
      false,
      (_did, _siid, _piid, value) =>
        typeof value === "boolean" ? (value ? "开启" : "关闭") : null,
    );
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
    context,
    snapshot,
    expire,
    refreshOnline,
  };
}

describe("设备报告的业务使用条件", () => {
  test("缺值不代表关闭；云缓存的关闭报告可供解释，但不能触发规则", () => {
    const home = household();
    expect(home.fact().has_value).toBe(false);
    expect(home.view().coverage.missing).toBe(1);
    expect(home.context().facts).toHaveLength(0);

    const result = home.read(false);
    expect(result.edges).toHaveLength(0);
    expect(home.fact()).toMatchObject({
      has_value: true,
      value: false,
      reason: "cloud_cache",
      rule_eligible: false,
    });
    expect(canTrigger(home.fact())).toBe(false);
    expect(home.view().coverage).toMatchObject({ missing: 0, valid: 0 });
    expect(home.context().facts[0]).toMatchObject({
      value: false,
      value_label: "关闭",
      observed_at: null,
      reason: "cloud_cache",
    });
    expect(home.context().coverage.unconfirmed).toBe(1);
  });

  test("迟到云缓存不能覆盖实时值、制造变化或延长实时报告的有效期", () => {
    const home = household();
    home.push(false);
    home.at(100);
    const change = home.push(true);
    expect(
      change.edges.map(({ before, after }) => [before.value, after.value]),
    ).toEqual([[false, true]]);
    const current = home.fact();
    home.at(900);
    expect(home.read(false).edges).toHaveLength(0);
    expect(home.fact()).toMatchObject({
      value: true,
      reason: "current",
      rule_eligible: true,
      evidence: current.evidence,
      expires_at: current.expires_at,
      last_change_at: current.last_change_at,
      read_candidate: { value: false },
    });
    expect(home.context().facts[0]?.value).toBe(true);
    home.at(1100);
    home.expire();
    expect(home.fact().reason).toBe("expired");
    expect(canTrigger(home.fact())).toBe(false);
  });

  test("同值续报维持有效状态，但不制造变化或让房间分析依据失效", () => {
    const home = household();
    home.push(false);
    const baseline = roomDependencies(home.snapshot(), null);
    const firstReport = home.fact().last_report_at;
    home.at(900);
    expect(home.push(false).edges).toHaveLength(0);
    expect(home.fact().last_report_at).not.toBe(firstReport);
    expect(home.fact().last_change_at).toBeNull();
    expect(
      roomDependenciesChanged(
        baseline,
        roomDependencies(home.snapshot(), null),
      ),
    ).toBe(false);
    home.at(1000);
    home.expire();
    expect(canTrigger(home.fact())).toBe(true);
    home.at(1900);
    home.expire();
    expect(home.fact()).toMatchObject({
      value: false,
      has_value: true,
      reason: "expired",
      rule_eligible: false,
    });
    expect(home.context().facts).toHaveLength(0);
    expect(
      roomDependenciesChanged(
        baseline,
        roomDependencies(home.snapshot(), null),
      ),
    ).toBe(true);
  });

  test("断连后重连与订阅确认不能复活旧值，恢复首报只建立比较起点", () => {
    const home = household();
    home.push(false);
    const evidence = home.fact().evidence;
    const baseline = roomDependencies(home.snapshot(), null);
    home.at(100);
    home.observe({ kind: "connection", status: "closed", reason: "network" });
    expect(home.view().devices[0]?.online).toBe(true);
    expect(home.fact()).toMatchObject({
      value: false,
      has_value: true,
      reason: "disconnected",
      rule_eligible: false,
      evidence,
    });
    expect(home.view().coverage.valid).toBe(0);
    expect(home.context().facts).toHaveLength(0);
    expect(
      roomDependenciesChanged(
        baseline,
        roomDependencies(home.snapshot(), null),
      ),
    ).toBe(true);
    home.connect("connection-2");
    expect(canTrigger(home.fact())).toBe(false);
    home.push(true, "connection-1");
    expect(home.fact().value).toBe(false);
    expect(home.push(true, "connection-2").edges).toHaveLength(0);
    expect(home.fact()).toMatchObject({
      value: true,
      reason: "current",
      rule_eligible: true,
    });
    home.at(200);
    expect(
      home
        .push(false, "connection-2")
        .edges.map(({ before, after }) => [before.value, after.value]),
    ).toEqual([[true, false]]);
  });

  test("过期值仍可查看，但不能用于规则；下一份报告不能推断缺失期间的变化", () => {
    const home = household();
    home.push(false);
    home.at(1000);
    home.expire();
    expect(home.fact()).toMatchObject({
      has_value: true,
      value: false,
      reason: "expired",
    });
    expect(canTrigger(home.fact())).toBe(false);
    expect(home.context().facts).toHaveLength(0);
    expect(home.push(true).edges).toHaveLength(0);
    expect(canTrigger(home.fact())).toBe(true);
    home.at(1100);
    expect(home.push(false).edges).toHaveLength(1);
  });

  test("积压中已超期的报告不能重新成为可触发规则的状态", () => {
    const home = household();
    home.push(false);
    home.at(2000);
    expect(home.push(true, "connection-1", 500).edges).toHaveLength(0);
    expect(home.fact()).toMatchObject({
      value: true,
      reason: "expired",
      rule_eligible: false,
    });
    expect(canTrigger(home.fact())).toBe(false);
    expect(home.context().facts).toHaveLength(0);
  });

  test("未配置有效期的实时报告可作待确认背景，不能自动触发规则", () => {
    const home = household({ configured: false });
    home.push(false);
    expect(home.push(true).edges).toHaveLength(0);
    expect(home.fact()).toMatchObject({
      value: true,
      reason: "unverified",
      rule_eligible: false,
    });
    expect(canTrigger(home.fact())).toBe(false);
    expect(home.context().facts[0]).toMatchObject({
      value: true,
      reason: "unverified",
    });
    expect(home.context().coverage.unconfirmed).toBe(1);
    expect(home.view().coverage.valid).toBe(0);
  });

  test("规格未知的原值可查看，但不能猜作灯光状态或规则依据", () => {
    const home = household({ knownSpec: false });
    home.push(false);
    expect(home.fact()).toMatchObject({
      has_value: true,
      value: false,
      reason: "spec_unknown",
      rule_eligible: false,
    });
    expect(canTrigger(home.fact())).toBe(false);
    expect(home.context().facts).toHaveLength(0);
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
      rule_eligible: true,
    });
    expect(home.push(1).edges).toHaveLength(0);
    expect(home.fact()).toMatchObject({
      value: false,
      reason: "invalid_value",
      rule_eligible: false,
    });
    expect(canTrigger(home.fact())).toBe(false);
    expect(home.context().facts).toHaveLength(0);
    expect(home.push(true).edges).toHaveLength(0);
    expect(canTrigger(home.fact())).toBe(true);
  });

  test("清单刷新确认离线撤销旧报告的使用资格，上线后仍须等待新的实时报告", () => {
    const home = household();
    home.push(false);
    const baseline = roomDependencies(home.snapshot(), null);
    home.refreshOnline(false);
    expect(home.view().devices[0]?.online).toBe(false);
    expect(home.fact()).toMatchObject({
      value: false,
      reason: "offline",
      rule_eligible: false,
    });
    expect(home.context().facts).toHaveLength(0);
    expect(
      roomDependenciesChanged(
        baseline,
        roomDependencies(home.snapshot(), null),
      ),
    ).toBe(true);
    home.refreshOnline(true);
    expect(home.view().devices[0]?.online).toBe(true);
    expect(canTrigger(home.fact())).toBe(false);
    expect(home.push(true).edges).toHaveLength(0);
    expect(canTrigger(home.fact())).toBe(true);
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
    expect(canTrigger(home.fact())).toBe(false);
    home.connect("connection-2");
    notify(true);
    expect(home.view().devices[0]?.online).toBe(false);
    notify(true, "connection-2");
    expect(home.view().devices[0]?.online).toBe(true);
    expect(canTrigger(home.fact())).toBe(false);
    expect(home.push(true, "connection-2").edges).toHaveLength(0);
    expect(canTrigger(home.fact())).toBe(true);
  });
});
