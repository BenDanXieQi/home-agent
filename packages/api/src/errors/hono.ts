import { errorDefinitions } from "./definitions";
import { currentTraceId } from "@home-agent/observability";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError, errorPayload } from "./index";
import { errorDiagnostics } from "./diagnostics";

export function errorResponse(
  c: Context,
  error: AppError,
  status: ContentfulStatusCode = errorDefinitions[error.code].status,
) {
  c.header("Cache-Control", "no-store");
  return c.json(errorPayload(error, currentTraceId()), status);
}

export function handleHttpError(error: Error, c: Context) {
  const applicationError =
    error instanceof AppError
      ? error
      : new AppError(
          error instanceof HTTPException && error.status < 500
            ? "http_error"
            : "internal_error",
          { cause: error },
        );
  const status =
    error instanceof HTTPException
      ? error.status
      : errorDefinitions[applicationError.code].status;
  if (
    status >= 500 ||
    (applicationError.operation && error.cause instanceof Error)
  ) {
    console.error(
      JSON.stringify({
        message: "Request failed",
        code: applicationError.code,
        diagnostics: errorDiagnostics(error),
        trace_id: currentTraceId(),
      }),
    );
  }
  // Keep middleware headers (e.g. Retry-After) without exposing its body or message.
  if (error instanceof HTTPException) {
    for (const [name, value] of error.getResponse().headers) {
      if (
        [
          "retry-after",
          "www-authenticate",
          "proxy-authenticate",
          "allow",
        ].includes(name)
      )
        c.header(name, value);
    }
  }
  return errorResponse(c, applicationError, status);
}

export async function readJsonBody(c: Context): Promise<unknown> {
  if (
    c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new AppError("content_type_required");
  }
  try {
    return await c.req.json();
  } catch (cause) {
    throw new AppError("invalid_json", { cause });
  }
}
