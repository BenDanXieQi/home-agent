import { atom } from "jotai";
import { householdAtom, householdSnapshotAtom } from "../household/state";
const emptyDevices: NonNullable<
  ReturnType<typeof householdSnapshotAtom.read>
>["projection"]["device"][string][] = [];
const deviceRecordsAtom = atom(
  (get) => get(householdSnapshotAtom)?.projection.device,
);
export const devicesAtom = atom((get) => {
  const records = get(deviceRecordsAtom);
  return records ? Object.values(records) : emptyDevices;
});
export const deviceCapabilityFailureCountAtom = atom(
  (get) =>
    get(devicesAtom).filter((device) => device.spec_status === "error").length,
);

export const deviceInventoryAtom = atom((get) => {
  const household = get(householdAtom);
  if (!household) return undefined;
  return {
    status:
      household.sync_status === "error"
        ? ("error" as const)
        : household.sync_status === "synced"
          ? ("ready" as const)
          : ("loading" as const),
    items: get(devicesAtom),
    error: household.error,
  };
});
export const deviceCountAtom = atom((get) => {
  const inventory = get(deviceInventoryAtom);
  return inventory?.status === "ready" ? inventory.items.length : null;
});
export const cameraCountAtom = atom((get) => {
  const inventory = get(deviceInventoryAtom);
  return inventory?.status === "ready"
    ? inventory.items.filter((device) => device.camera).length
    : null;
});
