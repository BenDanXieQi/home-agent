import { maximumComparedDevices } from "./log-data";
import { useCallback, useMemo, useState } from "react";
import type {
  historyDevices,
  LogEntry,
} from "../../modules/device-history/presentation";

/** Comparison selection survives display refinements; its time anchor belongs to a query. */
export function useLogComparison(
  devices: ReturnType<typeof historyDevices>,
  queryKey: string,
) {
  const [comparing, setComparing] = useState(false);
  const [savedCompareIds, setCompareIds] = useState<string[]>([]);
  const [savedAnchor, saveAnchor] = useState<{
    queryKey: typeof queryKey;
    row: LogEntry;
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
      saveAnchor(null);
    },
    [available],
  );
  const enterComparison = useCallback(
    (deviceId: string | null) => {
      saveAnchor(null);
      setComparing(true);
      setCompareIds((previous) =>
        previous.some((id) => available.has(id)) || !deviceId
          ? previous
          : [deviceId],
      );
    },
    [available],
  );
  const leaveComparison = useCallback(() => {
    saveAnchor(null);
    setComparing(false);
  }, []);
  const clearAnchor = useCallback(() => saveAnchor(null), []);
  const clearComparison = useCallback(() => {
    setCompareIds([]);
    saveAnchor(null);
  }, []);
  const setAnchor = useCallback(
    (row: LogEntry | null) => {
      saveAnchor(row ? { queryKey, row } : null);
    },
    [queryKey],
  );
  if (savedAnchor && savedAnchor.queryKey !== queryKey) saveAnchor(null);
  const anchor =
    savedAnchor?.queryKey === queryKey ? (savedAnchor?.row ?? null) : null;
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
      clearAnchor,
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
      clearAnchor,
    ],
  );
}
