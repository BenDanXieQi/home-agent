import type { LogEntry } from "../../modules/device-history/presentation";

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

export const sourceLabels = {
  push: "实时推送",
  retained: "保留消息",
  read: "属性读取",
  directory: "设备清单读取",
};

function describeEntry(row: LogEntry) {
  const timestamp = Date.parse(row.received_at);
  return {
    timestamp,
    time: timeFormatter.format(timestamp),
    preciseTime: preciseTimeFormatter.format(timestamp),
    dateTime: dateTimeFormatter.format(timestamp),
  };
}

// Reuse immutable history records across scrolling and comparison changes
// without retaining rows after the query releases them.
const presentations = new WeakMap<LogEntry, ReturnType<typeof describeEntry>>();
export function presentLogEntry(row: LogEntry) {
  const previous = presentations.get(row);
  if (previous) return previous;
  const presentation = describeEntry(row);
  presentations.set(row, presentation);
  return presentation;
}
