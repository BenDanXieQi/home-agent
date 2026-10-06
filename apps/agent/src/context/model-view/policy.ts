import type { Capability, Specification } from "./source";

const internalServices = new Set([
  "self-check",
  "air-conditioner-dev-mode",
  "product-appearance",
  "extra-device-information",
  "virtual-service",
  "demo",
  "air-condition-outlet-matching",
  "p2p-stream",
  "camera-ipc-cloud",
]);
const cameraAnalysisServices = new Set([
  "ai-detection",
  "motion-detection",
  "sound-recognition",
  "virtual-fence",
  "smart-care",
  "fire-smoke",
  "idm",
]);
const cameraDirections = new Set([
  "camera-fav-area/active-fav-area",
  "cruise/cruise-switch",
  "cruise/cruise-mode",
  "cruise/cruise-position",
]);
const internalProperties = new Set([
  "current-time",
  "operation-id",
  "audio-id",
  "cloud-video-id",
  "qrcode-information",
  "ip-address",
  "dhcp-server-mac-adress",
  "brand-id",
  "remote-id",
  "ac-ctrl-library",
  "ac-ctrl-library-crc32",
]);
const wholeSensorLabels = new Set([
  "传感器整体状态",
  "存在传感器",
  "Occupancy Sensor",
]);

export function createHouseholdPolicy(specification: Specification) {
  const presence = Object.entries(specification.spec).filter(
    ([address, m]) =>
      address.startsWith("prop.") &&
      m.service_type_name === "occupancy-sensor" &&
      m.type_name === "occupancy-status" &&
      (m.readable || m.notify),
  );
  const explicit = presence.filter(([, m]) =>
    wholeSensorLabels.has(m.service_description ?? ""),
  );
  const overall = explicit.length === 1 ? explicit[0]?.[0] : undefined;
  return (address: string, meta: Capability) =>
    exclusion(specification.category, address, meta, overall);
}

function exclusion(
  category: Specification["category"],
  address: string,
  meta: Capability,
  overall: string | undefined,
) {
  const service = meta.service_type_name ?? "";
  const property = meta.type_name ?? "";
  if (category === "camera") {
    if (
      address.startsWith("prop.") &&
      meta.writeable &&
      cameraDirections.has(`${service}/${property}`)
    )
      return null;
    return "camera_direction_only";
  }
  if (category === "occupancy-sensor") {
    if (address !== overall) return "presence_overall_only";
  } else if (service === "occupancy-sensor" && address !== overall) {
    return "embedded_presence_overall_only";
  }
  if (category === "motion-sensor" || service === "motion-sensor") {
    if (
      !(
        service === "motion-sensor" &&
        property === "motion-detected" &&
        address.startsWith("event.")
      )
    )
      return "motion_detection_only";
  }
  if (internalServices.has(service)) return "internal_service";
  if (service === "customized-service-for-ble")
    return "vendor_experimental_payload";
  if (internalProperties.has(property))
    return "internal_identifier_or_timestamp";
  if (property === "device-be-reset") return "device_lifecycle_event";
  if (
    service === "battery" &&
    ["voltage", "battery-cycle-count"].includes(property)
  )
    return "battery_diagnostic";
  if (
    ["switch", "switch-sensor"].includes(service) &&
    property === "temperature"
  )
    return "switch_internal_temperature";
  if (category === "lock" && cameraAnalysisServices.has(service))
    return "embedded_video_analysis_owned_by_backend";
  return null;
}
