import { maximumComparedDevices } from "./log-data";
import { useCallback, useMemo, useState } from "react";
import type { DeviceLogSnapshot } from "@home-agent/api/device-logs";

/** Comparison selection survives display refinements; its time anchor belongs to a capture. */
export function useLogComparison(
  devices: NonNullable<DeviceLogSnapshot["run"]>["devices"],
  runId: string | undefined,
) {
  const [comparing, setComparing] = useState(false);
  const [savedCompareIds, setCompareIds] = useState<string[]>([]);
  const [savedAnchor, saveAnchor] = useState<{
    runId: typeof runId;
    row: DeviceLogSnapshot["entries"][number];
  } | null>(null);
  const available = useMemo(
    () => new Map(devices.map((device) => [device.id, device])),
    [devices],
  );
  const compareIds = useMemo(
    () => savedCompareIds.filter((id) => available.has(id)),
    [savedCompareIds, available],
  );
  const compareDevices = useMemo(
    () => compareIds.map((id) => available.get(id)!),
    [compareIds, available],
  );
  const toggleComparison = useCallback(
    (id: string) => {
      setCompareIds((previous) => {
        const current = previous.filter((value) => available.has(value));
        return current.includes(id)
          ? current.filter((value) => value !== id)
          : current.length < maximumComparedDevices
            ? [...current, id]
            : current;
      });
      saveAnchor((previous) =>
        previous?.row.device_id === id ? null : previous,
      );
    },
    [available],
  );
  const enterComparison = useCallback(
    (deviceId: string | null) => {
      setComparing(true);
      setCompareIds((previous) =>
        previous.some((id) => available.has(id)) || !deviceId
          ? previous
          : [deviceId],
      );
    },
    [available],
  );
  const leaveComparison = useCallback(() => setComparing(false), []);
  const clearComparison = useCallback(() => {
    setCompareIds([]);
    saveAnchor(null);
  }, []);
  const setAnchor = useCallback(
    (row: DeviceLogSnapshot["entries"][number] | null) => {
      saveAnchor(row ? { runId, row } : null);
    },
    [runId],
  );
  const anchor =
    savedAnchor?.runId === runId ? (savedAnchor?.row ?? null) : null;
  return useMemo(
    () => ({
      comparing,
      compareIds,
      compareDevices,
      anchor,
      setAnchor,
      toggleComparison,
      enterComparison,
      leaveComparison,
      clearComparison,
    }),
    [
      comparing,
      compareIds,
      compareDevices,
      anchor,
      setAnchor,
      toggleComparison,
      enterComparison,
      leaveComparison,
      clearComparison,
    ],
  );
}
