import { execFile } from "node:child_process";
import { BlockList, isIPv4 } from "node:net";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const privateAddresses = new BlockList();
privateAddresses.addSubnet("10.0.0.0", 8, "ipv4");
privateAddresses.addSubnet("172.16.0.0", 12, "ipv4");
privateAddresses.addSubnet("192.168.0.0", 16, "ipv4");
const neighborsSchema = z.array(
  z.object({ dst: z.string(), lladdr: z.string().optional() }),
);

export function normalizeCameraMac(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^(?:[\da-f]{1,2}:){5}[\da-f]{1,2}$/i.test(value)
  )
    return undefined;
  return value
    .toLowerCase()
    .split(":")
    .map((part) => part.padStart(2, "0"))
    .join(":");
}

export function isCameraAddress(value: unknown) {
  return (
    typeof value === "string" &&
    isIPv4(value) &&
    privateAddresses.check(value, "ipv4")
  );
}

/** Resolve this camera's address from the host's existing neighbor table. */
export async function resolveCameraAddress(
  deviceMac: unknown,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const mac = normalizeCameraMac(deviceMac);
  if (!mac || (process.platform !== "darwin" && process.platform !== "linux"))
    return undefined;
  try {
    const options = {
      signal,
      timeout: 3_000,
      maxBuffer: 512 * 1024,
      encoding: "utf8" as const,
    };
    const neighbors =
      process.platform === "darwin"
        ? (await execute("/usr/sbin/arp", ["-an"], options)).stdout
            .split("\n")
            .flatMap((line) => {
              const match = /\(([^)]+)\) at ([\da-f:]+) /i.exec(line);
              return match ? [{ dst: match[1]!, lladdr: match[2]! }] : [];
            })
        : neighborsSchema.parse(
            JSON.parse(
              (await execute("ip", ["-j", "-4", "neigh", "show"], options))
                .stdout,
            ),
          );
    signal.throwIfAborted();
    const addresses = new Set(
      neighbors
        .filter(
          (neighbor) =>
            normalizeCameraMac(neighbor.lladdr) === mac &&
            isCameraAddress(neighbor.dst),
        )
        .map((neighbor) => neighbor.dst),
    );
    // Conflicting entries do not establish one camera address.
    return addresses.size === 1 ? [...addresses][0] : undefined;
  } catch {
    signal.throwIfAborted();
    console.warn("Camera neighbor address lookup unavailable");
    return undefined;
  }
}
