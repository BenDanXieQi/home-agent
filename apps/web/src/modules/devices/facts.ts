import { atom } from "jotai";
import type { Projection } from "@home-agent/api/household";
import { householdSnapshotAtom } from "../household/state";

const latestAtom = atom((get) => get(householdSnapshotAtom)?.projection.latest);
export const devicePropertiesAtom = atom((get) => {
  const grouped = new Map<string, Projection["latest"][string][]>();
  for (const property of Object.values(get(latestAtom) ?? {})) {
    const values = grouped.get(property.device_id);
    if (values) values.push(property);
    else grouped.set(property.device_id, [property]);
  }
  for (const values of grouped.values())
    values.sort((a, b) => a.siid - b.siid || a.piid - b.piid);
  return grouped;
});
