import type { LogEntry } from "../../modules/device-history/presentation";

export const maximumComparedDevices = 4;
export const logViews = [
  { value: "all", label: "全部记录" },
  { value: "property", label: "属性报告" },
  { value: "online", label: "在线状态" },
] as const;

export function filterLogEntries(
  entries: LogEntry[],
  {
    view,
    search,
  }: {
    view: (typeof logViews)[number]["value"];
    search: string;
  },
) {
  return entries.filter((row) => {
    const matchesView = view === "all" || row.kind === view;
    return (
      matchesView &&
      `${row.device_name} ${row.description ?? ""} ${row.property} ${row.displayValue}`
        .toLowerCase()
        .includes(search)
    );
  });
}

/** Entries are newest first; the first signal for each property is its displayed value. */
export function latestLogValues(entries: LogEntry[]) {
  const values = new Map<string, LogEntry>();
  for (const row of entries) {
    const key = JSON.stringify([row.device_id, row.kind, row.property]);
    if (!values.has(key)) values.set(key, row);
  }
  return [...values.values()];
}

export function groupLogEntriesBySecond(rows: LogEntry[]) {
  const bySecond = new Map<number, Map<string, LogEntry[]>>();
  const deviceCounts = new Map<string, number>();
  const rowIds = new Set<string>();
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
    rowIds.add(row.id);
  }
  return {
    buckets: [...bySecond].toSorted(([left], [right]) => right - left),
    counts: deviceCounts,
    ids: rowIds,
  };
}
export const historyRangePresets = [
  { label: "近 15 分钟", duration: 15 * 60_000 },
  { label: "近 1 小时", duration: 60 * 60_000 },
  { label: "近 6 小时", duration: 6 * 60 * 60_000 },
  { label: "近 24 小时", duration: 24 * 60 * 60_000 },
];
