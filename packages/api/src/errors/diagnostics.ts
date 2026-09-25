import { AppError } from "./index";

function safeIdentifier(value: unknown) {
  return typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value)
    ? value
    : undefined;
}

// Keep source locations, not the stack's message, function names or absolute paths.
function sourceLocations(stack: string | undefined) {
  const locations: string[] = [];
  for (const line of stack?.split("\n").slice(1, 40) ?? []) {
    if (!/^\s+at\s/.test(line)) continue;
    const location = line.match(
      /\b((?:apps|packages)\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?:\d+:\d+)\)?$/,
    )?.[1];
    if (location && !location.split("/").includes(".."))
      locations.push(location);
    if (locations.length === 5) break;
  }
  return locations;
}

export function errorDiagnostics(error: Error) {
  const causes: Array<{
    name: string;
    code?: string | undefined;
    operation?: string | undefined;
    syscall?: string | undefined;
    locations: string[];
  }> = [];
  const visited = new Set<Error>();
  let current: unknown = error;
  while (
    current instanceof Error &&
    !visited.has(current) &&
    causes.length < 4
  ) {
    visited.add(current);
    causes.push({
      name: safeIdentifier(current.name) ?? "Error",
      code: "code" in current ? safeIdentifier(current.code) : undefined,
      operation:
        current instanceof AppError
          ? safeIdentifier(current.operation)
          : undefined,
      syscall:
        "syscall" in current ? safeIdentifier(current.syscall) : undefined,
      locations: sourceLocations(current.stack),
    });
    current = current.cause;
  }
  return causes;
}
