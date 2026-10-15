export function parseRetryAfter(value: string | null, now = Date.now()) {
  if (value === null || value.trim() === "") return undefined;
  const text = value.trim();
  if (!/^\d+$/.test(text) && !/^[A-Za-z]{3,9}[, ]/.test(text)) return undefined;
  const delay = /^\d+$/.test(text)
    ? Number(text) * 1_000
    : Date.parse(text) - now;
  const boundedDelay = Math.max(0, delay);
  const retryAt = now + boundedDelay;
  if (
    !Number.isSafeInteger(retryAt) ||
    Math.abs(retryAt) > 8_640_000_000_000_000
  )
    return undefined;
  return boundedDelay;
}
