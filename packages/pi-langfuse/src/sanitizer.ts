const BASE64_DATA_URI = /data:[^,\s"'`]*;base64,[^\s"'`]*/gi;
const CREDENTIAL_FIELD =
  /^(?:(?:x[-_])?api[-_]?(?:key|token|secret)|authorization|proxy[-_]?authorization|cookies?|password|credentials?|secret|token|bearer|client[-_]?secret|private[-_]?key|secret[-_]?key|public[-_]?key|access[-_]?token|refresh[-_]?token)$/iu;
const OPAQUE_SIGNATURE_KEYS = new Set([
  "thinkingSignature",
  "textSignature",
  "thoughtSignature",
]);

/** Copy trace data through native JSON serialization, filtering exported secrets and media. */
export function sanitizeTraceValue(
  value: unknown,
  redactCredentialFields = false,
) {
  const json = JSON.stringify(
    value,
    function (this: unknown, key, item: unknown) {
      if (OPAQUE_SIGNATURE_KEYS.has(key)) return undefined;
      if (redactCredentialFields && CREDENTIAL_FIELD.test(key))
        return "[credential field omitted]";
      if (
        key === "data" &&
        typeof this === "object" &&
        this !== null &&
        "type" in this &&
        (this.type === "image" || this.type === "base64")
      )
        return "[base64 omitted]";
      if (typeof item === "string")
        return item.replace(BASE64_DATA_URI, "[base64 data URI omitted]");
      return item;
    },
  );
  const copy: unknown = json === undefined ? undefined : JSON.parse(json);
  return copy;
}
