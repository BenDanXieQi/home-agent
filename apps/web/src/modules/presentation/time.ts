const options = {
  clock: { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  precise: {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  },
  dateTime: {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  },
  minute: { hour: "2-digit", minute: "2-digit" },
  monthDay: { month: "numeric", day: "numeric" },
  monthDayTime: {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  },
  monthDayMinute: {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  },
} satisfies Record<string, Intl.DateTimeFormatOptions>;
const formatters = new Map<keyof typeof options, Intl.DateTimeFormat>();

/** Wall-clock display uses the browser's local zone; durations are formatted separately. */
export function formatTime(
  value: string | number | Date | null | undefined,
  style: keyof typeof options = "dateTime",
  missing = "—",
) {
  if (value == null) return missing;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return missing;
  let formatter = formatters.get(style);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("zh-CN", {
      ...options[style],
      hour12: false,
    });
    formatters.set(style, formatter);
  }
  return formatter.format(date);
}
