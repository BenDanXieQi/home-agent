import { atom } from "jotai";
import { selectAtom } from "jotai/utils";
import { replaceEqualDeep } from "@tanstack/query-core";
import { entityKey, type Projection } from "@home-agent/api/household";
import { householdSnapshotAtom } from "../household/state";

const latestAtom = atom((get) => get(householdSnapshotAtom)?.projection.latest);
function groupDeviceProperties(latest: ReturnType<typeof latestAtom.read>) {
  const grouped = Object.groupBy(
    Object.values(latest ?? {}),
    (property) => property.device_id,
  );
  for (const values of Object.values(grouped))
    values?.sort((a, b) => a.siid - b.siid || a.piid - b.piid);
  return grouped;
}
const devicePropertiesAtom = selectAtom<
  ReturnType<typeof latestAtom.read>,
  ReturnType<typeof groupDeviceProperties>
>(latestAtom, (latest, previous) =>
  replaceEqualDeep(previous, groupDeviceProperties(latest)),
);
const emptyProperties: Projection["latest"][string][] = [];
export function createDevicePropertiesAtom(deviceId: string) {
  return atom((get) => get(devicePropertiesAtom)[deviceId] ?? emptyProperties);
}

export function createDeviceCoverageAtom(accountId: string, deviceId: string) {
  return atom(
    (get) =>
      get(householdSnapshotAtom)?.projection.device_coverage[
        entityKey(accountId, deviceId)
      ],
  );
}
