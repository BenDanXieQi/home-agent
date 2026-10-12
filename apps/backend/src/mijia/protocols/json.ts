/** Native JSON source access preserves vendor identifiers beyond JS integer precision. */
export function parseProviderJson(text: string) {
  const parsed: unknown = JSON.parse(
    text.replace(/^&&&START&&&/, ""),
    (_key: string, value: unknown, context?: { source: string }) =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value)
        ? context!.source
        : value,
  );
  return parsed;
}
