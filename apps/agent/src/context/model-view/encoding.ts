import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { propertyValueSchema } from "@home-agent/api/observations";
import { memberListSchema } from "@home-agent/api/household-members";
import { accessLabel, type createHouseholdModelView } from "./view";
import { attentionSchema } from "./source";

type Semantic = ReturnType<typeof createHouseholdModelView>["semantic"];
const reference = z.int().nonnegative();
const valueRow = z.tuple([
  reference,
  propertyValueSchema,
  z.string().nullable().optional(),
  z.string().nullable().optional(),
  z.string().nullable().optional(),
]);
const reportRow = z.tuple([
  reference,
  z.string(),
  z.string().nullable(),
  z.string().nullable(),
  z.string().nullable(),
  z.array(valueRow),
]);
const deviceRow = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string().nullable(),
  z.boolean(),
  reference,
]);
const capabilityGroup = z.tuple([
  z.int().refine((v) => (v >= 1 && v <= 8) || v === 16),
  reference,
  reference,
  z.array(z.tuple([z.string(), z.string()])),
]);
const metaSchema = z.object({
  快照接收时间: z.string().nullable(),
  家庭: z.array(z.object({ 名称: z.string(), id: z.string() })),
  成员: z.array(
    memberListSchema.shape.members.element.extend({
      species: z.string().optional(),
      description: z.string().optional(),
    }),
  ),
  说明: z.record(z.string(), z.string()),
  最近关注: attentionSchema.optional(),
});

const format = {
  refs: "All indices are zero-based and resolved within this JSON. D device_id and C key are the actual query arguments.",
  D: ["device_id", "name", "room", "category", "online", "S_index"],
  C: ["access", "T_index", "first_C_index", "definitions"],
  S: "Each row lists C indices supported by a device.",
  T: "Property datatype or action/event kind.",
  R: [
    "D_index",
    "reason",
    "received_at",
    "observed_at",
    "expires_at",
    "V_rows",
  ],
  V: ["C_index", "raw_value", "unit", "enum_label", "last_change_at"],
  access: {
    "1": "read",
    "2": "write",
    "4": "notify",
    "8": "action",
    "16": "event",
  },
  access_combine: "Property access bits add, e.g. 7=read+write+notify.",
  nulls:
    "Missing trailing V cells are null. A V row always has raw_value, including legitimate null/false/0. Unknown measurement time is null; received_at is not measurement time.",
  C_index: "Definition at position j in a C group has index first_C_index+j.",
  C_definition: ["query_key", "name"],
};

export const encodedContextSchema = z.object({
  schema: z
    .record(z.string(), z.unknown())
    .refine(
      (value) => isDeepStrictEqual(value, format),
      "Unrecognized context format",
    ),
  meta: metaSchema,
  T: z.array(z.string()),
  C: z.array(capabilityGroup),
  S: z.array(z.array(reference)),
  D: z.array(deviceRow),
  R: z.array(reportRow),
});

const accessByLabel = new Map(
  [1, 2, 3, 4, 5, 6, 7, 8, 16].map((access) => [accessLabel(access), access]),
);
function numericAccess(value: string) {
  const access = accessByLabel.get(value);
  if (access === undefined)
    throw new Error(`Unknown capability access: ${value}`);
  return access;
}

function resolveReference<T>(rows: readonly T[], index: number, name: string) {
  const row = rows[index];
  if (row === undefined) throw new Error(`Invalid ${name} reference: ${index}`);
  return row;
}

/** Encode a semantic view in memory; file and model I/O belong to the caller. */
export function encodeHouseholdContext(semantic: Semantic) {
  const types = [
    ...new Set(semantic.设备组.flatMap((g) => g.能力.map((c) => c.类型))),
  ];
  const all = semantic.设备组.flatMap((group) => group.能力);
  const capabilityKey = (c: (typeof all)[number]) =>
    JSON.stringify([
      c.键,
      c.名称,
      numericAccess(c.权限),
      types.indexOf(c.类型),
    ]);
  const capabilities = [
    ...new Map(all.map((c) => [capabilityKey(c), c])).values(),
  ];
  const buckets = Map.groupBy(capabilities, (c) =>
    JSON.stringify([numericAccess(c.权限), types.indexOf(c.类型)]),
  );
  const ordered = buckets
    .values()
    .flatMap((items) => items)
    .toArray();
  const capabilityIndex = new Map(
    ordered.map((c, index) => [capabilityKey(c), index]),
  );
  let offset = 0;
  const groups = buckets
    .values()
    .map((items) => {
      const first = items[0]!;
      const group: z.infer<typeof capabilityGroup> = [
        numericAccess(first.权限),
        types.indexOf(first.类型),
        offset,
        items.map((c) => [c.键, c.名称]),
      ];
      offset += items.length;
      return group;
    })
    .toArray();
  const sets: number[][] = [];
  const setIndex = new Map<string, number>();
  const devices: z.infer<typeof deviceRow>[] = [];
  const deviceIndex = new Map<string, number>();
  const deviceKeys = new Map<
    string,
    Map<string, { index: number; name: string }>
  >();
  for (const group of semantic.设备组) {
    const keys = new Map<string, { index: number; name: string }>();
    const ids = group.能力.map((c) => {
      const index = capabilityIndex.get(capabilityKey(c));
      if (index === undefined)
        throw new Error("Capability missing from shared table");
      if (keys.has(c.键))
        throw new Error("Ambiguous query keys in capability set");
      keys.set(c.键, { index, name: c.名称 });
      return index;
    });
    const signature = JSON.stringify(ids);
    let si = setIndex.get(signature);
    if (si === undefined) {
      si = sets.length;
      sets.push(ids);
      setIndex.set(signature, si);
    }
    for (const device of group.设备) {
      if (deviceIndex.has(device.设备ID))
        throw new Error("Duplicate model device identity");
      deviceIndex.set(device.设备ID, devices.length);
      deviceKeys.set(device.设备ID, keys);
      devices.push([
        device.设备ID,
        device.名称,
        device.房间,
        device.类型,
        device.在线,
        si,
      ]);
    }
  }
  const reports: z.infer<typeof reportRow>[] = [];
  for (const report of semantic.状态报告) {
    const di = deviceIndex.get(report.设备ID);
    const keys = deviceKeys.get(report.设备ID);
    if (di === undefined || !keys)
      throw new Error("Report refers to unknown device");
    for (const group of report.报告组) {
      const values: z.infer<typeof valueRow>[] = group.属性.map((value) => {
        const cap = keys.get(value.键);
        if (!cap || cap.name !== value.名称)
          throw new Error("Report capability does not match device definition");
        const row: z.infer<typeof valueRow> = [
          cap.index,
          value.值,
          value.单位 ?? null,
          value.值标签 ?? null,
          value.可信变化时间 ?? null,
        ];
        while (row.length > 2 && row.at(-1) === null) row.pop();
        return row;
      });
      reports.push([
        di,
        group.原因,
        group.接收时间 ?? null,
        group.测量时间 ?? null,
        group.过期时间 ?? null,
        values,
      ]);
    }
  }
  const { 设备组: _devices, 状态报告: _reports, ...meta } = semantic;
  return {
    schema: structuredClone(format),
    meta: structuredClone(meta),
    T: types,
    C: groups,
    S: sets,
    D: devices,
    R: reports,
  };
}

export function decodeHouseholdContext(input: unknown) {
  const encoded = encodedContextSchema.parse(input);
  const capabilities = encoded.C.flatMap(
    ([access, type, start, definitions]) => {
      const datatype = resolveReference(encoded.T, type, "T");
      if (
        (access === 8) !== (datatype === "action") ||
        (access === 16) !== (datatype === "event")
      )
        throw new Error("Capability access and type disagree");
      return definitions.map(([key, name], offset) => ({
        index: start + offset,
        键: key,
        名称: name,
        权限: accessLabel(access),
        类型: datatype,
      }));
    },
  );
  capabilities.forEach((c, index) => {
    if (c.index !== index) throw new Error("Noncontiguous capability offsets");
  });
  const sets = encoded.S.map((indices) => {
    const result = indices.map((index) => {
      const { index: _index, ...capability } = resolveReference(
        capabilities,
        index,
        "C",
      );
      return capability;
    });
    if (new Set(result.map((c) => c.键)).size !== result.length)
      throw new Error("Ambiguous query keys in capability set");
    return result;
  });
  if (new Set(encoded.D.map(([id]) => id)).size !== encoded.D.length)
    throw new Error("Duplicate device identity");
  const groups = Map.groupBy(encoded.D, (device) => device[5])
    .entries()
    .map(([si, devices]) => ({
      设备: devices.map(([id, name, room, type, online]) => ({
        设备ID: id,
        名称: name,
        房间: room,
        类型: type,
        在线: online,
      })),
      能力: resolveReference(sets, si, "S"),
    }))
    .toArray();
  const deviceSets = new Map(
    encoded.D.map((device) => [
      device[0],
      resolveReference(sets, device[5], "S"),
    ]),
  );
  for (const [id, keys] of Object.entries(encoded.meta.最近关注 ?? {})) {
    const supported = deviceSets.get(id);
    if (
      !supported ||
      keys.some((key) => !supported.some((cap) => cap.键 === key))
    )
      throw new Error("Attention refers to unknown device or capability");
    if (new Set(keys).size !== keys.length)
      throw new Error("Duplicate attention keys");
  }
  const allowedSets = encoded.S.map((indices) => new Set(indices));
  const seenValues = new Set<string>();
  const reports = encoded.R.map(
    ([di, reason, received, observed, expires, rows]) => {
      const device = resolveReference(encoded.D, di, "D");
      const allowed = resolveReference(allowedSets, device[5], "S");
      const values = rows.map(([ci, raw, unit, label, changed]) => {
        if (!allowed.has(ci))
          throw new Error("Report capability does not belong to its device");
        const cap = resolveReference(capabilities, ci, "C");
        if (cap.类型 === "action" || cap.类型 === "event")
          throw new Error("Actions and events have no property state");
        const identity = JSON.stringify([di, ci]);
        if (seenValues.has(identity))
          throw new Error("Duplicate property state");
        seenValues.add(identity);
        return {
          键: cap.键,
          名称: cap.名称,
          值: raw,
          ...(unit != null ? { 单位: unit } : {}),
          ...(label != null ? { 值标签: label } : {}),
          ...(changed != null ? { 可信变化时间: changed } : {}),
        };
      });
      return {
        deviceId: device[0],
        group: {
          原因: reason,
          ...(received !== null ? { 接收时间: received } : {}),
          ...(observed !== null ? { 测量时间: observed } : {}),
          ...(expires !== null ? { 过期时间: expires } : {}),
          属性: values,
        },
      };
    },
  );
  const byDevice = Map.groupBy(reports, ({ deviceId }) => deviceId)
    .entries()
    .map(([deviceId, items]) => ({
      设备ID: deviceId,
      报告组: items.map(({ group }) => group),
    }))
    .toArray();
  return {
    ...encoded.meta,
    设备组: groups,
    状态报告: byDevice,
  };
}
