import { deviceCategoryLabel } from "../../modules/devices/presentation";
import { atom } from "jotai";
import { householdSnapshotAtom } from "../../modules/household/state";
import { devicesAtom } from "../../modules/devices/state";
export const deviceSearchAtom = atom("");
export const deviceFilterAtom = atom("all");
const emptyDeviceFilters = { room: "", category: "", capability: "" };
const scopeEpochAtom = atom(
  (get) => get(householdSnapshotAtom)?.scope_epoch ?? "",
);
const scopedDeviceFiltersAtom = atom({
  scope_epoch: "",
  filters: emptyDeviceFilters,
});
export const deviceFiltersAtom = atom(
  (get) => {
    const { scope_epoch, filters } = get(scopedDeviceFiltersAtom);
    return scope_epoch === get(scopeEpochAtom) ? filters : emptyDeviceFilters;
  },
  (get, set, filters: typeof emptyDeviceFilters) => {
    set(scopedDeviceFiltersAtom, {
      filters,
      scope_epoch: get(scopeEpochAtom),
    });
  },
);

const byName = ([, left]: [string, string], [, right]: [string, string]) =>
  left.localeCompare(right, "zh-CN");
export const deviceFilterOptionsAtom = atom((get) => {
  const rooms = new Map<string, string>();
  const categories = new Map<string, string>();
  const capabilities = new Set<string>();
  for (const device of get(devicesAtom)) {
    rooms.set(
      JSON.stringify([device.home_id, device.room_id]),
      device.room_name ?? "未分配房间",
    );
    categories.set(
      JSON.stringify(device.category),
      device.category ? deviceCategoryLabel(device.category) : "未分类",
    );
    for (const capability of device.capability_tags)
      capabilities.add(capability);
  }
  return {
    rooms: [...rooms].toSorted(byName),
    categories: [...categories].toSorted(byName),
    capabilities,
  };
});
export const filteredDevicesAtom = atom((get) => {
  const devices = get(devicesAtom);
  const filter = get(deviceFilterAtom);
  const search = get(deviceSearchAtom).trim().toLocaleLowerCase();
  const { room, category, capability } = get(deviceFiltersAtom);
  return devices.filter(
    (device) =>
      (filter === "all" || device.availability === filter) &&
      (!room || JSON.stringify([device.home_id, device.room_id]) === room) &&
      (!category || JSON.stringify(device.category) === category) &&
      (!capability ||
        device.capability_tags.some((tag) => tag === capability)) &&
      `${device.name} ${device.alias ?? ""} ${device.model}`
        .toLocaleLowerCase()
        .includes(search),
  );
});
