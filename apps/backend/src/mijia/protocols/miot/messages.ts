import { parseProviderJson } from "../json";
import { sourceMetadata } from "../source-metadata";
import { z } from "zod";

const scalar = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const envelope = z.object({
  method: z.literal("properties_changed"),
  params: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
});
const change = z.object({
  siid: z.number().int().positive(),
  piid: z.number().int().positive(),
  value: scalar,
});
const eventEnvelope = z.object({
  method: z.literal("event_occured"),
  params: z.object({
    did: z.union([z.string(), z.number().int().safe()]).optional(),
    siid: z.number().int().positive(),
    eiid: z.number().int().positive(),
    arguments: z.array(
      z.object({
        piid: z.number().int().positive(),
        value: z.unknown(),
      }),
    ),
  }),
});
export function eventTopics(did: string) {
  return [`device/${did}/up/event_occured/#`];
}
export function deviceTopics(did: string) {
  return [`device/${did}/up/properties_changed/#`, `device/${did}/state/#`];
}
export function directoryTopics(uid: string, deviceIds: readonly string[]) {
  return [
    ...(subscribableDevice(uid)
      ? [`user/${uid}/g_op/bind`, `user/${uid}/g_op/unbind`]
      : []),
    ...[...new Set(deviceIds)]
      .filter(subscribableDevice)
      .flatMap((did) => [
        `device/${did}/g_op/rename`,
        `device/${did}/g_op/hr_change`,
      ]),
  ];
}
export function subscribableDevice(did: string) {
  return (
    did.length > 0 &&
    !["/", "#", "+", " "].some((character) => did.includes(character)) &&
    !did.includes(String.fromCharCode(0))
  );
}
function decodeMessage(topic: string, raw: unknown) {
  const directory =
    /^(?:user\/([^/]+)\/g_op\/(bind|unbind)|device\/([^/]+)\/g_op\/(rename|hr_change))$/.exec(
      topic,
    );
  if (directory)
    return [
      {
        observation: {
          kind: "directory" as const,
          did: directory[3] ?? "",
          topic,
        },
        raw: {},
      },
    ];
  const online = /^device\/([^/]+)\/state\/(online|offline)$/.exec(topic);
  if (online)
    return [
      {
        observation: {
          kind: "online" as const,
          did: online[1]!,
          online: online[2] === "online",
        },
        raw,
      },
    ];
  const eventAddress =
    /^device\/([^/]+)\/up\/event_occured(?:\/(\d+)\/(\d+))?$/.exec(topic);
  if (eventAddress) {
    const parsed = eventEnvelope.safeParse(raw);
    if (!parsed.success) return [];
    const event = parsed.data.params;
    if (
      (event.did !== undefined && String(event.did) !== eventAddress[1]) ||
      (eventAddress[2] !== undefined &&
        (Number(eventAddress[2]) !== event.siid ||
          Number(eventAddress[3]) !== event.eiid))
    )
      return [];
    return [
      {
        observation: {
          kind: "event" as const,
          did: eventAddress[1]!,
          siid: event.siid,
          eiid: event.eiid,
          arguments: event.arguments,
        },
        raw,
      },
    ];
  }
  const address =
    /^device\/([^/]+)\/up\/properties_changed(?:\/(\d+)\/(\d+))?$/.exec(topic);
  if (!address) return [];
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) return [];
  const entries = Array.isArray(parsed.data.params)
    ? parsed.data.params
    : [parsed.data.params];
  const changes: { value: z.infer<typeof change>; raw: object }[] = [];
  for (const row of entries) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const did = "did" in row ? row.did : undefined;
    if (
      did !== undefined &&
      did !== null &&
      ((typeof did !== "string" && typeof did !== "number") ||
        String(did) !== address[1])
    )
      return [];
    const value = change.safeParse(row);
    if (value.success && Object.hasOwn(row, "value"))
      changes.push({ value: value.data, raw: row });
  }
  if (
    changes.length === 1 &&
    address[2] !== undefined &&
    (changes[0]!.value.siid !== Number(address[2]) ||
      changes[0]!.value.piid !== Number(address[3]))
  )
    return [];
  const fields = raw && typeof raw === "object" ? raw : {};
  return changes.map((item) => ({
    observation: {
      kind: "property" as const,
      did: address[1]!,
      ...item.value,
    },
    raw: {
      ...("id" in fields ? { id: fields.id } : {}),
      ...("time" in fields ? { time: fields.time } : {}),
      ...("timestamp" in fields ? { timestamp: fields.timestamp } : {}),
      method: parsed.data.method,
      params: item.raw,
    },
  }));
}
function parsePushPayload(payload: Buffer) {
  try {
    return parseProviderJson(payload.toString("utf8"));
  } catch {
    return null;
  }
}
export function decodePush(topic: string, payload: Buffer) {
  return decodeMessage(topic, parsePushPayload(payload)).map(
    ({ observation }) => observation,
  );
}
export function pushObservations(
  topic: string,
  payload: Buffer,
  retain: boolean,
  source_id: string,
  collection_generation: string,
) {
  const decoded = decodeMessage(topic, parsePushPayload(payload));
  const received_at = new Date().toISOString();
  const packet_id = crypto.randomUUID();
  return decoded.map(({ observation, raw }) => {
    const source = sourceMetadata(topic, raw);
    if (observation.kind === "property") {
      if (source.completeness === "received_fields")
        source.completeness = "partial";
      source.limitations.push("property_row_payload_only");
    }
    return {
      ...observation,
      source_metadata: {
        ...source,
        collection: {
          source_id,
          generation: collection_generation,
          delivery_kind: retain ? ("baseline" as const) : ("live" as const),
          packet_id,
        },
      },
      topic,
      source_id,
      collection_generation,
      delivery_kind: retain ? ("baseline" as const) : ("live" as const),
      observed_at: null,
      received_at,
      packet_id,
      packet_bytes: payload.length,
      source_event_id: null,
      source_sequence: null,
    };
  });
}
export function connectionObservation(
  source_id: string,
  collection_generation: string,
  status: "connecting" | "connected" | "closed",
  reason: string | null = null,
) {
  return {
    kind: "connection" as const,
    source_id,
    collection_generation,
    status,
    reason,
    received_at: new Date().toISOString(),
  };
}
export function subscriptionObservation(
  source_id: string,
  collection_generation: string,
  topic: string,
  status: "pending" | "confirmed" | "failed" | "cancelled",
  reason: string | null = null,
  code: number | null = null,
) {
  return {
    kind: "subscription" as const,
    source_id,
    collection_generation,
    topic,
    status,
    reason,
    code,
    received_at: new Date().toISOString(),
  };
}
export type MiotObservation =
  | ReturnType<typeof pushObservations>[number]
  | ReturnType<typeof connectionObservation>
  | ReturnType<typeof subscriptionObservation>;
