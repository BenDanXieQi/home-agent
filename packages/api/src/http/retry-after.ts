/** Parse HTTP Retry-After (delay-seconds or HTTP-date) into a nonnegative delay. */
export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const text = value.trim();
  if (!/^\d+$/.test(text) && !/^[A-Za-z]{3,9}[, ]/.test(text)) return undefined;
  const delay = /^\d+$/.test(text)
    ? Number(text) * 1_000
    : Date.parse(text) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
