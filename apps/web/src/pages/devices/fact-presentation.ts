import { formatDevicePropertyValue } from "../../modules/devices/presentation";
import type { Projection } from "@home-agent/api/household";

const summaryPriority = [
  "temperature",
  "relative-humidity",
  "humidity",
  "target-temperature",
  "brightness",
  "mode",
  "occupancy-status",
  "motion-state",
  "illumination",
  "pm2.5-density",
  "co2-density",
  "battery-level",
];

export function summarizeProperties(
  properties: Projection["latest"][string][],
  device: Projection["device"][string],
) {
  const mainService =
    device.category === "outlet"
      ? "switch"
      : device.category === "camera"
        ? "camera-control"
        : device.category;
  const priority = (property: (typeof properties)[number]) => {
    if (
      property.type_name === "on" &&
      property.service_type_name === mainService
    )
      return -1;
    const index = summaryPriority.indexOf(property.type_name ?? "");
    return index < 0 ? summaryPriority.length : index;
  };
  return properties
    .filter((property) => property.has_value)
    .toSorted((a, b) => priority(a) - priority(b))
    .slice(0, 2);
}

export function propertyValue(property: Projection["latest"][string]) {
  if (!property.has_value) return "无值";
  return formatDevicePropertyValue(property.value, property);
}
