import {
  automationCapabilitiesSchema,
  deriveAutomationProperty,
} from "@home-agent/api/automations";
import { deriveDeviceValue } from "@home-agent/api/devices";
import type { z } from "zod";
import type { HouseholdRuntime } from "../runtime";

export function readAutomationCapabilities(
  household: HouseholdRuntime,
  eventTypes: string[] = [],
) {
  const result: z.infer<typeof automationCapabilitiesSchema> = {
    properties: [],
    actions: [],
    event_types: eventTypes,
    notification: true,
  };
  for (const device of Object.values(household.snapshot().projection.device)) {
    if (device.archived || device.spec_status !== "ready") continue;
    const specification = household.specification(device.id);
    for (const [key, capability] of Object.entries(specification.spec)) {
      if (key.startsWith("prop.")) {
        const derived = deriveAutomationProperty(capability);
        if (derived)
          result.properties.push({
            ...derived,
            device_id: device.id,
            device_name: [device.room_name, device.name]
              .filter(Boolean)
              .join(" · "),
            property_key: key,
          });
      } else if (key.startsWith("action.")) {
        const parameters = capability.in_params ?? [];
        const inputs = parameters.flatMap((param) => {
          const value = deriveDeviceValue(param);
          return value ? [{ ...value, name: param.name }] : [];
        });
        if (inputs.length !== parameters.length) continue;
        result.actions.push({
          device_id: device.id,
          device_name: [device.room_name, device.name]
            .filter(Boolean)
            .join(" · "),
          action_key: key,
          description: capability.description,
          inputs,
        });
      }
    }
  }
  return result;
}
