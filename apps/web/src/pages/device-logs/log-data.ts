import type { DeviceLogSnapshot } from "@home-agent/api/device-logs";

export const maximumComparedDevices = 4;
export const logViews = [
  { value: "signals", label: "设备信号" },
  { value: "connection", label: "连接与订阅" },
] as const;

export function selectLogEntries(
  entries: DeviceLogSnapshot["entries"],
  {
    comparing,
    compareIds,
    deviceId,
    filtering,
    visibleIds,
  }: {
    comparing: boolean;
    compareIds: readonly string[];
    deviceId: string | null;
    filtering: boolean;
    visibleIds: ReadonlySet<string>;
  },
) {
  return entries
    .filter((row) =>
      comparing
        ? row.device_id !== null && compareIds.includes(row.device_id)
        : deviceId
          ? row.device_id === deviceId
          : !filtering ||
            (row.device_id !== null && visibleIds.has(row.device_id)),
    )
    .toReversed();
}

export function filterLogEntries(
  entries: DeviceLogSnapshot["entries"],
  {
    view,
    showRepeated,
    search,
  }: {
    view: (typeof logViews)[number]["value"];
    showRepeated: boolean;
    search: string;
  },
) {
  return entries.filter((row) => {
    const matchesView =
      view === "connection"
        ? row.kind === "connection" || row.kind === "subscription"
        : row.kind === "property" || row.kind === "online";
    return (
      matchesView &&
      (showRepeated || row.change !== "same") &&
      `${row.device_name} ${row.description} ${row.property} ${row.value}`
        .toLowerCase()
        .includes(search)
    );
  });
}

/** Entries are newest first; the first signal for each property is its displayed value. */
export function latestLogValues(entries: DeviceLogSnapshot["entries"]) {
  const values = new Map<string, DeviceLogSnapshot["entries"][number]>();
  for (const row of entries) {
    if (row.kind !== "property" && row.kind !== "online") continue;
    const key = JSON.stringify([row.device_id, row.kind, row.property]);
    if (!values.has(key)) values.set(key, row);
  }
  return [...values.values()];
}

export function groupLogEntriesBySecond(rows: DeviceLogSnapshot["entries"]) {
  const bySecond = new Map<
    number,
    Map<string | null, DeviceLogSnapshot["entries"]>
  >();
  const deviceCounts = new Map<string | null, number>();
  const rowSequences = new Set<number>();
  for (const row of rows) {
    const second = Math.floor(Date.parse(row.received_at) / 1000);
    let deviceRows = bySecond.get(second);
    if (!deviceRows) {
      deviceRows = new Map();
      bySecond.set(second, deviceRows);
    }
    const group = deviceRows.get(row.device_id);
    if (group) group.push(row);
    else deviceRows.set(row.device_id, [row]);
    deviceCounts.set(row.device_id, (deviceCounts.get(row.device_id) ?? 0) + 1);
    rowSequences.add(row.sequence);
  }
  return {
    buckets: [...bySecond].toSorted(([left], [right]) => right - left),
    counts: deviceCounts,
    sequences: rowSequences,
  };
}
