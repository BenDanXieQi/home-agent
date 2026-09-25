import type { MijiaFailureReason } from "@home-agent/api/mijia";
import { recordFailure, withSpan } from "@home-agent/observability";
import { safeMijiaError } from "./errors";

/** Only static operation names and sanitized failures cross the tracing boundary. */
export function mijiaOperation<T>(
  name: string,
  fallback: MijiaFailureReason,
  run: () => Promise<T>,
) {
  return withSpan(
    `mijia.${name}`,
    { "mijia.region": "cn" },
    async () => {
      try {
        return await run();
      } catch (error) {
        throw safeMijiaError(error, fallback);
      }
    },
    {
      onError: (span, error) => {
        const failure = safeMijiaError(error, fallback);
        if (
          failure.reason === "cancelled" ||
          failure.reason === "request_cancelled"
        ) {
          span.setAttribute("operation.cancelled", true);
        } else {
          recordFailure(span, failure, failure.code);
        }
      },
    },
  );
}
