import { z } from "zod";
import exclusions from "./miot-exclusions.json";
import type { Capability, Specification } from "./source";
import { compareText } from "./source";
import { createHouseholdPolicy } from "./policy";

const exclusionSchema = z.object({
  services: z.array(z.string()).default([]),
  properties: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  events: z.array(z.string()).default([]),
});
const filters = z.record(z.string(), exclusionSchema).parse(exclusions.filters);
const units = new Map(
  Object.entries({
    celsius: "°C",
    percentage: "%",
    lux: "lx",
    seconds: "s",
    hours: "h",
    watt: "W",
  }),
);
// MIoT standard quantities used by the model view; source units take precedence.
const standardUnits = new Map(
  Object.entries({
    temperature: "°C",
    "relative-humidity": "%",
    "pm2.5-density": "µg/m³",
    "pm10-density": "µg/m³",
    pm1: "µg/m³",
    "atmospheric-pressure": "Pa",
    "co2-density": "ppm",
    "battery-level": "%",
    illumination: "lx",
    "electric-power": "W",
    "surge-power": "W",
    power: "W",
  }),
);

export function hasStandardNumericReading(meta: Capability) {
  return (
    meta.readable &&
    !meta.writeable &&
    /^(?:u?int\d*|float|double)$/.test(meta.format)
  );
}

export function capabilityUnit(meta: Capability) {
  const explicit = meta.unit && meta.unit !== "none" ? meta.unit : undefined;
  const unit =
    explicit ??
    (hasStandardNumericReading(meta)
      ? standardUnits.get(meta.type_name ?? "")
      : undefined);
  return unit ? (units.get(unit) ?? unit) : null;
}

export function capabilityAccess(address: string, meta: Capability) {
  if (address.startsWith("action.")) return 8;
  if (address.startsWith("event.")) return 16;
  if (!address.startsWith("prop.")) return 0;
  return (
    (meta.readable ? 1 : 0) + (meta.writeable ? 2 : 0) + (meta.notify ? 4 : 0)
  );
}

export function capabilityType(address: string, meta: Capability) {
  return address.startsWith("action.")
    ? "action"
    : address.startsWith("event.")
      ? "event"
      : meta.format;
}

function vendorExclusion(spec: Specification, address: string) {
  const rule = filters[spec.urn.split(":").slice(0, 6).join(":")];
  if (!rule) return false;
  const [kind, service, instance] = address.split(".");
  if (!service || !instance)
    throw new Error(`Invalid capability address: ${address}`);
  const entries =
    kind === "prop"
      ? rule.properties
      : kind === "action"
        ? rule.actions
        : kind === "event"
          ? rule.events
          : [];
  return (
    rule.services.includes("*") ||
    rule.services.includes(service) ||
    entries.includes(`${service}.${instance}`) ||
    entries.includes(`${service}.*`)
  );
}

export function createCapabilityCatalog(spec: Specification) {
  const policy = createHouseholdPolicy(spec);
  const audit = Object.entries(spec.spec).map(([address, metadata]) => {
    const reason =
      policy(address, metadata) ??
      (vendorExclusion(spec, address) ? "official_model_filter" : null) ??
      (metadata.description.includes("【不支持") ||
      metadata.description.includes("（不支持）")
        ? "unsupported_by_spec"
        : null) ??
      (capabilityAccess(address, metadata) === 0
        ? "event_parameter_or_no_access"
        : null);
    return { address, metadata, reason };
  });
  const eligible = audit.filter((entry) => entry.reason === null);
  const byType = Map.groupBy(
    eligible,
    ({ address, metadata }) => metadata.type_name || address,
  );
  const keys = eligible.map((entry) => {
    const { address, metadata } = entry;
    let key = metadata.type_name || address;
    if ((byType.get(key)?.length ?? 0) > 1)
      key += `@${metadata.service_description || metadata.service_type_name || address}`;
    return { ...entry, key };
  });
  const byName = Map.groupBy(keys, ({ key }) => key);
  const entries = keys.map((entry) => ({
    ...entry,
    key:
      (byName.get(entry.key)?.length ?? 0) > 1
        ? `${entry.key}@${entry.address}`
        : entry.key,
    stateReason: stateExclusion(entry.address, entry.metadata, spec),
  }));
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length)
    throw new Error("Ambiguous capability query keys");
  const ordered = entries.toSorted((a, b) => compareText(a.key, b.key));
  return {
    entries: ordered,
    byKey: new Map(ordered.map((entry) => [entry.key, entry])),
    audit,
  };
}

export function stateExclusion(
  address: string,
  meta: Capability,
  spec: Specification,
) {
  if (
    hasStandardNumericReading(meta) &&
    ["voltage", "electric-current", "power-consumption"].includes(
      meta.type_name ?? "",
    )
  )
    return "optional_measurement";
  if (meta.format === "string" && !meta.value_list?.length)
    return "uninterpreted_string";
  if (
    meta.service_type_name === "indicator-light" &&
    ["on", "mode", "brightness"].includes(meta.type_name ?? "")
  ) {
    const serviceId = address.split(".")[1];
    const hasSwitch = Object.entries(spec.spec).some(
      ([candidate, m]) =>
        candidate.split(".")[1] === serviceId &&
        m.service_type_name === "indicator-light" &&
        m.type_name === "on" &&
        m.readable &&
        m.writeable,
    );
    if (hasSwitch) return "configuration_detail";
  }
  return null;
}
