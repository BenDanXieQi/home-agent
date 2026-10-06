import { groupBy } from "es-toolkit/array";
import type { z } from "zod";
import { accessLabel, type createHouseholdModelView } from "./view";
import {
  format,
  capabilityGroup,
  deviceRow,
  deviceStateSchema,
  reportGroup,
  valueRow,
} from "./format";

type Semantic = ReturnType<typeof createHouseholdModelView>["semantic"];

const accessByLabel = new Map(
  [1, 2, 3, 4, 5, 6, 7, 8, 16].map((access) => [accessLabel(access), access]),
);
function numericAccess(value: string) {
  const access = accessByLabel.get(value);
  if (access === undefined)
    throw new Error(`Unknown capability access: ${value}`);
  return access;
}

/** Encode a semantic view in memory; file and model I/O belong to the caller. */
export function encodeHouseholdContext(semantic: Semantic) {
  const all = semantic.设备组.flatMap((group) => group.能力);
  const capabilityKey = (c: (typeof all)[number]) =>
    JSON.stringify([c.键, c.名称, numericAccess(c.权限), c.类型]);
  const capabilities = [
    ...new Map(all.map((c) => [capabilityKey(c), c])).values(),
  ];
  const buckets = groupBy(capabilities, (c) =>
    JSON.stringify([numericAccess(c.权限), c.类型]),
  );
  const ordered = Object.values(buckets).flat();
  const capabilityIndex = new Map(
    ordered.map((c, index) => [capabilityKey(c), index]),
  );
  let offset = 0;
  const groups = Object.values(buckets).map((items) => {
    const first = items[0]!;
    const group: z.infer<typeof capabilityGroup> = [
      numericAccess(first.权限),
      first.类型,
      items.map((c, index) => [offset + index, c.键, c.名称]),
    ];
    offset += items.length;
    return group;
  });
  const sets: number[][] = [];
  const setIndex = new Map<string, number>();
  const devices: z.infer<typeof deviceRow>[] = [];
  const online = new Map<string, boolean>();
  const deviceKeys = new Map<string, Map<string, string>>();
  for (const group of semantic.设备组) {
    const keys = new Map<string, string>();
    const ids = group.能力.map((c) => {
      const index = capabilityIndex.get(capabilityKey(c));
      if (index === undefined)
        throw new Error("Capability missing from shared table");
      if (keys.has(c.键))
        throw new Error("Ambiguous query keys in capability set");
      keys.set(c.键, c.名称);
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
      if (deviceKeys.has(device.设备ID))
        throw new Error("Duplicate model device identity");
      deviceKeys.set(device.设备ID, keys);
      online.set(device.设备ID, device.在线);
      devices.push([device.设备ID, device.名称, device.房间, device.类型, si]);
    }
  }
  const reports = new Map<string, z.infer<typeof reportGroup>[]>();
  for (const report of semantic.状态报告) {
    const keys = deviceKeys.get(report.设备ID);
    if (!keys) throw new Error("Report refers to unknown device");
    const reportGroups: z.infer<typeof reportGroup>[] = [];
    for (const group of report.报告组) {
      const values: z.infer<typeof valueRow>[] = group.属性.map((value) => {
        if (keys.get(value.键) !== value.名称)
          throw new Error("Report capability does not match device definition");
        const row: z.infer<typeof valueRow> = [
          value.键,
          value.值,
          value.单位 ?? null,
          value.值标签 ?? null,
          value.可信变化时间 ?? null,
        ];
        while (row.length > 2 && row.at(-1) === null) row.pop();
        return row;
      });
      const row: z.infer<typeof reportGroup> = [
        group.原因,
        values,
        group.接收时间 ?? null,
        group.测量时间 ?? null,
        group.过期时间 ?? null,
      ];
      while (row.length > 2 && row.at(-1) === null) row.pop();
      reportGroups.push(row);
    }
    if (reports.has(report.设备ID)) throw new Error("Duplicate report device");
    reports.set(report.设备ID, reportGroups);
  }
  const states: z.infer<typeof deviceStateSchema>[] = devices.map(
    ([id, name]) => ({
      device_id: id,
      name,
      online: online.get(id)!,
      reports: reports.get(id) ?? [],
    }),
  );
  // Keep the serialized prefix independent of reports, timestamps and online state.
  return {
    schema: structuredClone(format),
    instructions: structuredClone(semantic.说明),
    C: groups,
    S: sets,
    D: devices,
    meta: structuredClone({ 家庭: semantic.家庭 }),
    ...(semantic.最近关注 !== undefined
      ? { attention: structuredClone(semantic.最近关注) }
      : {}),
    received_at: semantic.快照接收时间,
    states,
    observations: structuredClone(semantic.最新观察),
  };
}
