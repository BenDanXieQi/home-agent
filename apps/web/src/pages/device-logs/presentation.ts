import type { DeviceLogSnapshot } from "@home-agent/api/device-logs";

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const preciseTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export const time = (value: string | number) =>
  timeFormatter.format(typeof value === "string" ? Date.parse(value) : value);

export const changeLabels = {
  first: "首次上报",
  changed: "值变化",
  same: "重复上报",
  control: "连接记录",
};

function describeEntry(row: DeviceLogSnapshot["entries"][number]) {
  const timestamp = Date.parse(row.received_at);
  return {
    timestamp,
    time: timeFormatter.format(timestamp),
    preciseTime: preciseTimeFormatter.format(timestamp),
    dateTime: dateTimeFormatter.format(timestamp),
  };
}

// SSE appends immutable rows. Reuse their presentation across scrolling and
// comparison changes without retaining rows after the capture window drops them.
const presentations = new WeakMap<
  DeviceLogSnapshot["entries"][number],
  ReturnType<typeof describeEntry>
>();
export function presentLogEntry(row: DeviceLogSnapshot["entries"][number]) {
  const previous = presentations.get(row);
  if (previous) return previous;
  const presentation = describeEntry(row);
  presentations.set(row, presentation);
  return presentation;
}
