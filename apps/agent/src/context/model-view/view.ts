import { groupBy } from "es-toolkit/array";
import { latestObservations } from "./observations";
import type { z } from "zod";
import type { agentDevicePropertySchema } from "@home-agent/api/agent-context";
import {
  capabilityAccess,
  capabilityType,
  capabilityUnit,
  createCapabilityCatalog,
} from "./capabilities";
import {
  attentionSchema,
  compareText,
  requireReadyContext,
  ModelContextError,
  type Household,
  type ReceivedContext,
} from "./source";

type Fact = z.infer<typeof agentDevicePropertySchema>;
type Entry = ReturnType<typeof createCapabilityCatalog>["entries"][number];

export function accessLabel(access: number) {
  if (access === 8) return "动作";
  if (access === 16) return "事件";
  return `${access & 1 ? "读" : ""}${access & 2 ? "写" : ""}${access & 4 ? "推送" : ""}`;
}

function describeCapability(entry: Entry) {
  return {
    键: entry.key,
    名称: entry.metadata.description.trim(),
    权限: accessLabel(capabilityAccess(entry.address, entry.metadata)),
    类型: capabilityType(entry.address, entry.metadata),
  };
}

function describeDevice(
  device: Household["device"][string],
  room: string,
  online: boolean,
) {
  return {
    设备ID: device.device_id,
    名称: device.alias || device.name,
    房间: room,
    类型: device.category,
    在线: online,
  };
}

function stateValue(entry: Entry, fact: Fact) {
  const unit = capabilityUnit(entry.metadata);
  const matches =
    entry.metadata.value_list?.filter((item) => item.value === fact.value) ??
    [];
  const label =
    matches.length === 1
      ? matches[0]?.description || matches[0]?.name
      : undefined;
  return {
    键: entry.key,
    名称: entry.metadata.description.trim(),
    值: fact.value,
    ...(unit ? { 单位: unit } : {}),
    ...(label ? { 值标签: label } : {}),
    ...(fact.last_change_at ? { 可信变化时间: fact.last_change_at } : {}),
  };
}

function reportGroup(fact: Fact) {
  return {
    原因: fact.reason,
    ...(fact.evidence?.received_at
      ? { 接收时间: fact.evidence.received_at }
      : {}),
    ...(fact.evidence?.observed_at
      ? { 测量时间: fact.evidence.observed_at }
      : {}),
    ...(fact.expires_at ? { 过期时间: fact.expires_at } : {}),
  };
}

export function createHouseholdModelView(
  snapshot: ReceivedContext,
  attention: z.infer<typeof attentionSchema> = {},
) {
  const source = structuredClone(requireReadyContext(snapshot));
  const { household, state } = source;
  const devices = Object.values(household.device)
    .filter((d) => !d.archived)
    .toSorted((a, b) => compareText(a.device_id, b.device_id));
  const devicesById = new Map(devices.map((d) => [d.device_id, d]));
  if (devicesById.size !== devices.length)
    throw new ModelContextError(
      "invalid_identity",
      "Duplicate device identity",
    );
  const facts = new Map<string, Fact>();
  for (const fact of Object.values(state.latest)) {
    if (!devicesById.has(fact.device_id))
      throw new ModelContextError(
        "invalid_identity",
        "Unresolved property device identity",
      );
    const key = JSON.stringify([
      fact.device_id,
      `prop.${fact.siid}.${fact.piid}`,
    ]);
    if (facts.has(key))
      throw new ModelContextError(
        "invalid_identity",
        "Duplicate property identity",
      );
    facts.set(key, fact);
  }
  const rooms = new Map(
    Object.values(household.room).map((r) => [r.room_id, r.name]),
  );
  const online = new Map(state.online.map((d) => [d.device_id, d.online]));
  const catalogs = new Map<
    string,
    ReturnType<typeof createCapabilityCatalog>
  >();
  const byDevice = new Map<
    string,
    ReturnType<typeof createCapabilityCatalog>
  >();
  const rows = devices.map((device) => {
    const specification = device.spec_id
      ? household.specs[device.spec_id]
      : undefined;
    let catalog = device.spec_id ? catalogs.get(device.spec_id) : undefined;
    if (!catalog) {
      catalog = specification
        ? createCapabilityCatalog(specification)
        : { entries: [], byKey: new Map<string, Entry>(), audit: [] };
      if (device.spec_id) catalogs.set(device.spec_id, catalog);
    }
    byDevice.set(device.device_id, catalog);
    const capabilities = catalog.entries.map(describeCapability);
    const values = catalog.entries.flatMap((entry) => {
      const fact = facts.get(JSON.stringify([device.device_id, entry.address]));
      if (
        !fact?.has_value ||
        fact.reason === "spec_unknown" ||
        entry.stateReason
      )
        return [];
      return [{ timing: reportGroup(fact), value: stateValue(entry, fact) }];
    });
    const reports = Object.values(
      groupBy(values, ({ timing }) => JSON.stringify(timing)),
    ).map((items) => ({
      ...items[0]!.timing,
      属性: items.map(({ value }) => value),
    }));
    return {
      device: describeDevice(
        device,
        rooms.get(device.room_id ?? "") ?? "未分配房间",
        online.get(device.device_id) ?? device.online,
      ),
      capabilities,
      reports,
      audit: catalog.audit.map((item) => ({
        device_id: device.device_id,
        device_name: device.name,
        address: item.address,
        name: item.metadata.description,
        reason: item.reason,
      })),
    };
  });
  const groups = Object.values(
    groupBy(rows, ({ capabilities }) => JSON.stringify(capabilities)),
  ).map((items) => ({
    设备: items.map(({ device }) => device),
    能力: items[0]!.capabilities,
  }));
  const reports = rows
    .filter((row) => row.reports.length)
    .map((row) => ({
      设备ID: row.device.设备ID,
      报告组: row.reports,
    }))
    .toSorted((a, b) => compareText(a.设备ID, b.设备ID));
  const audit = rows.flatMap((row) => row.audit);
  const recent = Object.fromEntries(
    Object.entries(attention).flatMap(([id, keys]) => {
      const retained = [...new Set(keys)].filter((key) =>
        byDevice.get(id)?.byKey.has(key),
      );
      return retained.length ? [[id, retained] as const] : [];
    }),
  );
  const semantic = {
    快照接收时间: source.receivedAt,
    家庭: Object.values(household.home)
      .filter((h) => !h.archived)
      .map((h) => ({ 名称: h.name, id: h.home_id })),
    空间关系: source.spatial,
    设备组: groups,
    状态报告: reports,
    最新观察: latestObservations(source),
    近期操作: source.operations,
    ...(Object.keys(recent).length ? { 最近关注: recent } : {}),
  };

  function query(
    deviceId: string,
    keys: readonly string[],
    kind: "spec" | "state",
  ) {
    const device = devicesById.get(deviceId);
    const catalog = byDevice.get(deviceId);
    if (!device || !catalog) throw new Error(`Unknown device: ${deviceId}`);
    const selected = keys.length
      ? [...new Set(keys)]
      : catalog.entries
          .filter(
            (entry) => kind === "spec" || entry.address.startsWith("prop."),
          )
          .map((entry) => entry.key);
    const results = selected.map((key) => {
      const entry = catalog.byKey.get(key);
      if (!entry) throw new Error(`Unknown or excluded capability: ${key}`);
      if (kind === "spec")
        return [
          {
            key,
            address: entry.address,
            ...structuredClone(entry.metadata),
          },
        ];
      if (!entry.address.startsWith("prop."))
        throw new Error(`Actions and events have no property state: ${key}`);
      const fact = facts.get(JSON.stringify([deviceId, entry.address]));
      if (fact?.reason === "spec_unknown") return [];
      if (!fact?.has_value)
        return [
          {
            key,
            名称: entry.metadata.description,
            has_value: false,
            reason: fact?.reason ?? "not_received",
          },
        ];
      const value = stateValue(entry, fact);
      return [
        {
          key,
          名称: entry.metadata.description,
          has_value: true,
          reason: fact.reason,
          value: fact.value,
          ...(value.单位 ? { unit: value.单位 } : {}),
          ...(value.值标签 ? { value_label: value.值标签 } : {}),
          ...(fact.evidence
            ? {
                source: fact.evidence.source,
                delivery_kind: fact.evidence.delivery_kind,
                received_at: fact.evidence.received_at,
                ...(fact.evidence.observed_at
                  ? { observed_at: fact.evidence.observed_at }
                  : {}),
              }
            : {}),
          ...(fact.expires_at ? { expires_at: fact.expires_at } : {}),
          ...(fact.last_change_at
            ? { last_change_at: fact.last_change_at }
            : {}),
          ...(fact.read_candidate
            ? { read_candidate: structuredClone(fact.read_candidate) }
            : {}),
        },
      ];
    });
    return {
      source: "snapshot",
      snapshot_received_at: source.receivedAt,
      device_id: deviceId,
      device_name: device.name,
      results: results.flat(),
    };
  }
  return { semantic, audit, query };
}
