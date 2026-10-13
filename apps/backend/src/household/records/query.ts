import { createHash } from "node:crypto";
import { AppError } from "@home-agent/api/errors";
import type {
  provenanceQuerySchema,
  commandQuerySchema,
} from "@home-agent/api/action-provenance";
import type { accessHousehold } from "../access";

/** A continuation belongs to one exact selection and household, not a relevance search. */
export function provenanceQueryHash(
  ...[kind, scope, input]:
    | [
        "commands",
        Pick<ReturnType<typeof accessHousehold>, "identity" | "assertCurrent">,
        ReturnType<typeof commandQuerySchema.parse>,
      ]
    | [
        "materials",
        Pick<ReturnType<typeof accessHousehold>, "identity" | "assertCurrent">,
        ReturnType<typeof provenanceQuerySchema.parse>,
      ]
) {
  const { cursor: _cursor, limit: _limit, ...selection } = input;
  const hash = createHash("sha256")
    .update(JSON.stringify([kind, scope.identity, selection]))
    .digest("hex");
  if (input.cursor && input.cursor.query_hash !== hash)
    throw new AppError("invalid_request");
  return hash;
}
