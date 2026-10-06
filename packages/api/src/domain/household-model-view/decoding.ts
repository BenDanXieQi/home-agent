import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { accessLabel } from "./view";
import { attentionSchema, compareText } from "./source";
import {
  format,
  reference,
  capabilityGroup,
  deviceRow,
  deviceStateSchema,
  metaSchema,
  latestObservationsSchema,
} from "./format";

export const encodedContextSchema = z.object({
  schema: z
    .record(z.string(), z.unknown())
    .refine(
      (value) => isDeepStrictEqual(value, format),
      "Unrecognized context format",
    ),
  instructions: z.record(z.string(), z.string()),
  meta: metaSchema,
  attention: attentionSchema.optional(),
  received_at: z.string().nullable(),
  C: z.array(capabilityGroup),
  S: z.array(z.array(reference)),
  D: z.array(deviceRow),
  states: z.array(deviceStateSchema),
  observations: latestObservationsSchema,
});

function resolveReference<T>(rows: readonly T[], index: number, name: string) {
  const row = rows[index];
  if (row === undefined) throw new Error(`Invalid ${name} reference: ${index}`);
  return row;
}

export function decodeHouseholdContext(input: unknown) {
  const encoded = encodedContextSchema.parse(input);
  const capabilities = encoded.C.flatMap(([access, datatype, definitions]) => {
    if (
      (access === 8) !== (datatype === "action") ||
      (access === 16) !== (datatype === "event")
    )
      throw new Error("Capability access and type disagree");
    return definitions.map(([index, key, name]) => ({
      index,
      键: key,
      名称: name,
      权限: accessLabel(access),
      类型: datatype,
    }));
  });
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
  const devicesById = new Map(encoded.D.map((device) => [device[0], device]));
  const statesById = new Map(
    encoded.states.map((state) => [state.device_id, state]),
  );
  if (statesById.size !== encoded.states.length)
    throw new Error("Duplicate state device");
  if (statesById.size !== devicesById.size)
    throw new Error("State must contain exactly one entry per device");
  for (const state of encoded.states) {
    const device = devicesById.get(state.device_id);
    if (!device || device[1] !== state.name)
      throw new Error("State device identity or name does not match inventory");
  }
  const groups = Map.groupBy(encoded.D, (device) => device[4])
    .entries()
    .map(([si, devices]) => ({
      设备: devices.map(([id, name, room, type]) => ({
        设备ID: id,
        名称: name,
        房间: room,
        类型: type,
        在线: statesById.get(id)!.online,
      })),
      能力: resolveReference(sets, si, "S"),
    }))
    .toArray();
  const deviceSets = new Map(
    encoded.D.map((device) => [
      device[0],
      resolveReference(sets, device[4], "S"),
    ]),
  );
  for (const [id, keys] of Object.entries(encoded.attention ?? {})) {
    const supported = deviceSets.get(id);
    if (
      !supported ||
      keys.some((key) => !supported.some((cap) => cap.键 === key))
    )
      throw new Error("Attention refers to unknown device or capability");
    if (new Set(keys).size !== keys.length)
      throw new Error("Duplicate attention keys");
  }
  const allowedSets = sets.map(
    (items) => new Map(items.map((cap) => [cap.键, cap])),
  );
  const seenValues = new Set<string>();
  const reports = encoded.states.flatMap(
    ({ device_id, reports: reportGroups }) =>
      reportGroups.map(
        ([reason, rows, receivedTime, observedTime, expiresTime]) => {
          const received = receivedTime ?? undefined;
          const observed = observedTime ?? undefined;
          const expires = expiresTime ?? undefined;
          const device = devicesById.get(device_id)!;
          const allowed = resolveReference(allowedSets, device[4], "S");
          const values = rows.map(([key, raw, unit, label, changed]) => {
            const cap = allowed.get(key);
            if (!cap)
              throw new Error(
                "Report capability does not belong to its device",
              );
            if (cap.类型 === "action" || cap.类型 === "event")
              throw new Error("Actions and events have no property state");
            const identity = JSON.stringify([device_id, key]);
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
              ...(received !== undefined ? { 接收时间: received } : {}),
              ...(observed !== undefined ? { 测量时间: observed } : {}),
              ...(expires !== undefined ? { 过期时间: expires } : {}),
              属性: values,
            },
          };
        },
      ),
  );
  const byDevice = Map.groupBy(reports, ({ deviceId }) => deviceId)
    .entries()
    .map(([deviceId, items]) => ({
      设备ID: deviceId,
      报告组: items.map(({ group }) => group),
    }))
    .toArray()
    .toSorted((a, b) => compareText(a.设备ID, b.设备ID));
  return {
    快照接收时间: encoded.received_at,
    ...encoded.meta,
    说明: encoded.instructions,
    设备组: groups,
    状态报告: byDevice,
    最新观察: encoded.observations,
    ...(encoded.attention !== undefined ? { 最近关注: encoded.attention } : {}),
  };
}
