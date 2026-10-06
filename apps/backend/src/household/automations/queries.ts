import {
  automationQueryLimits,
  type AutomationCapabilities,
  type automationCapabilitiesQuerySchema,
  type automationListQuerySchema,
} from "@home-agent/api/automations";
import { AppError } from "@home-agent/api/errors";
import type { z } from "zod";
import type { automations } from "../../db/schema";

function page<T>(items: T[], input: z.infer<typeof automationListQuerySchema>) {
  const selected = items.slice(input.offset, input.offset + input.limit);
  // Leave room for metadata; never truncate an individual capability or rule.
  while (
    selected.length &&
    Buffer.byteLength(JSON.stringify(selected)) >
      automationQueryLimits.responseBytes - 512
  )
    selected.pop();
  if (!selected.length && input.offset < items.length)
    throw new AppError("request_too_large");
  const next = input.offset + selected.length;
  return {
    items: selected,
    total: items.length,
    next_offset: next < items.length ? next : null,
  };
}

export function queryAutomationCapabilities(
  input: z.infer<typeof automationCapabilitiesQuerySchema>,
  capabilities: AutomationCapabilities,
) {
  const query = input.query?.toLocaleLowerCase();
  const matches = (item: {
    device_id: string;
    device_name: string;
    description: string;
  }) =>
    (!input.device_id || item.device_id === input.device_id) &&
    (!query ||
      [item.device_name, item.description].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ));
  const items = [
    ...capabilities.properties
      .filter(matches)
      .toSorted(
        (a, b) =>
          a.device_id.localeCompare(b.device_id) ||
          a.property_key.localeCompare(b.property_key),
      )
      .map((item) => ({ ...item, type: "property" as const })),
    ...capabilities.actions
      .filter(matches)
      .toSorted(
        (a, b) =>
          a.device_id.localeCompare(b.device_id) ||
          a.action_key.localeCompare(b.action_key),
      )
      .map((item) => ({ ...item, type: "action" as const })),
    ...capabilities.event_types
      .filter(
        (event) =>
          !input.device_id &&
          (!query || event.toLocaleLowerCase().includes(query)),
      )
      .toSorted()
      .map((event_type) => ({ type: "event" as const, event_type })),
  ];
  return { ...page(items, input), notification: capabilities.notification };
}

export function queryAutomations(
  input: z.infer<typeof automationListQuerySchema>,
  rows: (typeof automations.$inferSelect)[],
) {
  const query = input.query?.toLocaleLowerCase();
  const items = rows
    .filter(
      (row) =>
        !query || row.definition.name.toLocaleLowerCase().includes(query),
    )
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((row) => ({
      id: row.id,
      revision: row.revision,
      enabled: row.enabled,
      name: row.definition.name,
      updated_at: row.updatedAt.toISOString(),
    }));
  return page(items, input);
}
