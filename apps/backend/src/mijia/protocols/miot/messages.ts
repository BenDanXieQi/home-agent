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
export function deviceTopics(did: string) {
  return [`device/${did}/up/properties_changed/#`, `device/${did}/state/#`];
}
export function subscribableDevice(did: string) {
  return (
    did.length > 0 &&
    !["/", "#", "+", " "].some((character) => did.includes(character)) &&
    !did.includes(String.fromCharCode(0))
  );
}
export function decodePush(topic: string, payload: Buffer) {
  const online = /^device\/([^/]+)\/state\/(online|offline)$/.exec(topic);
  if (online)
    return [
      {
        kind: "online" as const,
        did: online[1]!,
        online: online[2] === "online",
      },
    ];
  const address =
    /^device\/([^/]+)\/up\/properties_changed(?:\/(\d+)\/(\d+))?$/.exec(topic);
  if (!address) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString("utf8"));
  } catch {
    return [];
  }
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) return [];
  const entries = Array.isArray(parsed.data.params)
    ? parsed.data.params
    : [parsed.data.params];
  const changes: z.infer<typeof change>[] = [];
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
    if (value.success && Object.hasOwn(row, "value")) changes.push(value.data);
  }
  if (
    changes.length === 1 &&
    address[2] !== undefined &&
    (changes[0]!.siid !== Number(address[2]) ||
      changes[0]!.piid !== Number(address[3]))
  )
    return [];
  return changes.map((item) => ({
    kind: "property" as const,
    did: address[1]!,
    ...item,
  }));
}
export function pushObservations(
  topic: string,
  payload: Buffer,
  retain: boolean,
  source_id: string,
  collection_generation: string,
) {
  const received_at = new Date().toISOString();
  return decodePush(topic, payload).map((item) => ({
    ...item,
    topic,
    source_id,
    collection_generation,
    delivery_kind: retain ? ("baseline" as const) : ("live" as const),
    observed_at: null,
    received_at,
    source_event_id: null,
    source_sequence: null,
  }));
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
