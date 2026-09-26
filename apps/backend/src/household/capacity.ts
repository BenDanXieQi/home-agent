import type { Projection } from "@home-agent/api/household";
import { householdLimits, jsonBytes } from "./config";

/** Admission belongs to directory acquisition, never lifecycle transitions. */
export function directoryFits(
  directory: Pick<Projection, "home" | "room" | "device">,
) {
  return (
    Object.keys(directory.device).length <= householdLimits.devices &&
    jsonBytes(directory) <= householdLimits.directoryBytes
  );
}

/** Diagnostics are sampled on request, not maintained as a second state ledger. */
export function projectionBytes(projection: Projection) {
  const { home, room, device, ...metadata } = projection;
  return {
    directory: jsonBytes({ home, room, device }),
    metadata: jsonBytes(metadata),
    projection: jsonBytes(projection),
  };
}
