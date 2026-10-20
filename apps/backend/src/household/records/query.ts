import { createHash } from "node:crypto";
import { AppError } from "@home-agent/api/errors";
import type {
  provenanceQuerySchema,
  commandQuerySchema,
} from "@home-agent/api/action-provenance";

export function provenanceQueryHash(
  ...[kind, input]:
    | ["commands", ReturnType<typeof commandQuerySchema.parse>]
    | ["materials", ReturnType<typeof provenanceQuerySchema.parse>]
) {
  const { cursor: _cursor, limit: _limit, ...selection } = input;
  const hash = createHash("sha256")
    .update(JSON.stringify([kind, selection]))
    .digest("hex");
  if (input.cursor && input.cursor.query_hash !== hash)
    throw new AppError("invalid_request");
  return hash;
}
