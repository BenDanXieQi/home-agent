import { formatTime } from "../../modules/presentation/time";
import type { LogEntry } from "../../modules/device-history/presentation";

export const time = (value: string | number) => formatTime(value, "clock");

function describeEntry(row: LogEntry) {
  const timestamp = Date.parse(row.received_at);
  return {
    timestamp,
    time: formatTime(timestamp, "clock"),
    preciseTime: formatTime(timestamp, "precise"),
    dateTime: formatTime(timestamp),
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
