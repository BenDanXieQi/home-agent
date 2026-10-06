import { deviceCategoryLabel } from "../../modules/devices/presentation";
import { useCallback, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import type { historyDevices } from "../../modules/device-history/presentation";
import { devicesAtom } from "../../modules/devices/state";

const emptyFilters = { query: "", room: "", category: "" };

/** Owns device selection and refinements shared by the picker and log reader. */
export function useDeviceSelection(
  allDevices: ReturnType<typeof historyDevices>,
) {
  const records = useAtomValue(devicesAtom);
  const inventory = useMemo(
    () => new Map(records.map((device) => [device.id, device])),
    [records],
  );
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [filters, setFilters] = useState(emptyFilters);
  const updateFilters = useCallback((change: Partial<typeof emptyFilters>) => {
    setFilters((previous) => ({ ...previous, ...change }));
    setDeviceId(null);
  }, []);
  const clearFilters = useCallback(() => {
    setFilters(emptyFilters);
    setDeviceId(null);
  }, []);
  const { query, room, category } = filters;
  const search = query.trim().toLowerCase();
  const filtering = Boolean(search || room || category);
  const devices = useMemo(
    () =>
      allDevices.filter((device) => {
        const metadata = inventory.get(device.id);
        return (
          `${device.name} ${device.room} ${device.id} ${metadata?.model ?? ""}`
            .toLowerCase()
            .includes(search) &&
          (!room || device.room === room) &&
          (!category ||
            (category === "camera"
              ? metadata?.camera
              : JSON.stringify(metadata?.category ?? "未分类") === category))
        );
      }),
    [allDevices, inventory, search, room, category],
  );
  const visibleIds = useMemo(
    () => new Set(devices.map((device) => device.id)),
    [devices],
  );
  const selectedDevice = useMemo(
    () => allDevices.find((device) => device.id === deviceId),
    [allDevices, deviceId],
  );
  const roomOptions = useMemo(
    () => [
      { value: "", label: "全部房间" },
      ...[...new Set(allDevices.map((device) => device.room))]
        .toSorted((left, right) => left.localeCompare(right, "zh-CN"))
        .map((value) => ({ value, label: value })),
    ],
    [allDevices],
  );
  const categoryOptions = useMemo(
    () => [
      { value: "", label: "全部类型" },
      { value: "camera", label: "摄像头" },
      ...[
        ...new Set(
          allDevices.map(
            (device) => inventory.get(device.id)?.category ?? "未分类",
          ),
        ),
      ]
        .filter((value) => value !== "camera")
        .toSorted((left, right) => left.localeCompare(right, "zh-CN"))
        .map((value) => ({
          value: JSON.stringify(value),
          label: deviceCategoryLabel(value),
        })),
    ],
    [allDevices, inventory],
  );
  const selectionLabel =
    selectedDevice?.name ??
    (filtering ? `筛选结果 · ${devices.length} 台` : "全部设备");
  return useMemo(
    () => ({
      allDevices,
      devices,
      visibleIds,
      deviceId,
      setDeviceId,
      filters,
      updateFilters,
      filtering,
      clearFilters,
      selectedDevice,
      selectionLabel,
      roomOptions,
      categoryOptions,
    }),
    [
      allDevices,
      devices,
      visibleIds,
      deviceId,
      filters,
      updateFilters,
      filtering,
      clearFilters,
      selectedDevice,
      selectionLabel,
      roomOptions,
      categoryOptions,
    ],
  );
}
