import { sourceMetadataSchema } from "@home-agent/api/action-provenance";

export function providerPayload(value: unknown, maxBytes = 48 * 1024) {
  let redacted = false;
  const serialized = JSON.stringify(value, (key, item: unknown) => {
    if (
      /token|cookie|authorization|ssecurity|password|credential|secret|signature|clientSign|^headers$|^session$/i.test(
        key,
      )
    ) {
      redacted = true;
      return undefined;
    }
    return item;
  });
  if (!serialized || Buffer.byteLength(serialized) > maxBytes)
    return { payload: {}, omitted: true, redacted };
  const parsed: unknown = JSON.parse(serialized);
  return { payload: parsed, omitted: false, redacted };
}
export function sourceMetadata(
  endpoint: string,
  raw: unknown,
  specification: string | null = null,
) {
  const bounded = providerPayload(raw);
  const fields =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const message = "id" in fields ? fields.id : null;
  const time =
    "time" in fields
      ? fields.time
      : "timestamp" in fields
        ? fields.timestamp
        : null;
  return sourceMetadataSchema.parse({
    provider: "mijia",
    endpoint,
    message_id:
      typeof message === "string" ||
      (typeof message === "number" && Number.isSafeInteger(message))
        ? String(message)
        : null,
    raw_time:
      typeof time === "string" ||
      (typeof time === "number" && Number.isSafeInteger(time))
        ? time
        : null,
    time_unit: time === null ? null : "unknown",
    source_time: null,
    specification,
    provider_payload:
      bounded.payload &&
      typeof bounded.payload === "object" &&
      !Array.isArray(bounded.payload)
        ? bounded.payload
        : { body: bounded.payload },
    parsing_version: 1,
    completeness: bounded.omitted
      ? "omitted"
      : bounded.redacted
        ? "partial"
        : "received_fields",
    limitations: [
      ...(bounded.omitted ? ["provider_payload_exceeds_budget"] : []),
      ...(bounded.redacted ? ["provider_fields_redacted"] : []),
      time === null
        ? "source_timestamp_missing"
        : "source_time_unit_unverified",
    ],
  });
}
