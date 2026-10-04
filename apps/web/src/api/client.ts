import {
  createBackendClient,
  type BackendClient,
} from "@home-agent/backend/client";
import { parseRetryAfter } from "@home-agent/api/http/retry-after";
import { apiErrorSchema } from "@home-agent/api/contracts";
import { RequestError, type ClientErrorCode } from "./errors";

export type RpcRequest<R extends Response = Response> = (
  client: BackendClient,
  options: { init: RequestInit },
) => Promise<R>;
export type RpcJsonRequest<T> = RpcRequest<Response & { json(): Promise<T> }>;
type ResponseSchema<T> = { parse: (data: unknown) => T };
type RetryPolicy = {
  maxRetries: number;
  codes: readonly ClientErrorCode[];
};
export const retryOnceOnTransportFailure: RetryPolicy = {
  maxRetries: 1,
  codes: ["network_error", "request_timeout"],
};
export type RequestOptions = {
  signal?: AbortSignal | undefined;
  // Per-attempt limit. The caller's signal bounds the whole operation, including retries.
  timeoutMs?: number;
  keepalive?: boolean;
  retry?: RetryPolicy;
};

function transportError(error: unknown, signal: AbortSignal) {
  if (error instanceof RequestError) return error;
  if (signal.aborted)
    return new RequestError({
      code:
        signal.reason instanceof DOMException &&
        signal.reason.name === "TimeoutError"
          ? "request_timeout"
          : "request_cancelled",
    });
  return new RequestError({
    code: error instanceof SyntaxError ? "invalid_response" : "network_error",
  });
}

/** Inject transport once. Endpoint calls retain hc's inferred input/output types. */
export function createApiClient(
  baseUrl = "/",
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  const transport: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, cache: "no-store" });
  const rpc = createBackendClient(baseUrl, { fetch: transport });

  async function execute<T>(
    send: RpcRequest,
    decode: (response: Response) => Promise<T>,
    options: RequestOptions = {},
  ) {
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(options.timeoutMs ?? 12_000),
      ]);
      try {
        signal.throwIfAborted();
        const response = await send(rpc, {
          init: { signal, ...(options.keepalive ? { keepalive: true } : {}) },
        });
        if (!response.ok) {
          const details = apiErrorSchema.safeParse(
            await response.json().catch((cause: unknown) => {
              if (cause instanceof SyntaxError) return null;
              throw cause;
            }),
          );
          throw new RequestError(
            details.success ? details.data : { code: "invalid_response" },
            response.status,
          );
        }
        const result = await decode(response);
        signal.throwIfAborted();
        return result;
      } catch (cause) {
        const error = transportError(cause, signal);
        if (
          options.signal?.aborted ||
          !options.retry ||
          attempt >= options.retry.maxRetries ||
          !options.retry.codes.some((code) => code === error.details.code)
        )
          throw error;
      }
    }
  }

  function requestJsonResponse<T>(
    send: RpcJsonRequest<NoInfer<T>>,
    schema: ResponseSchema<T>,
    options?: RequestOptions,
  ) {
    return execute(
      send,
      async (response) => {
        const payload: unknown = await response.json();
        let data: T;
        try {
          data = schema.parse(payload);
        } catch {
          throw new RequestError({ code: "invalid_response" });
        }
        return {
          data,
          retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")),
        };
      },
      options,
    );
  }

  async function requestJson<T>(
    send: RpcJsonRequest<NoInfer<T>>,
    schema: ResponseSchema<T>,
    options?: RequestOptions,
  ) {
    return (await requestJsonResponse(send, schema, options)).data;
  }

  function requestEmpty(send: RpcRequest, options?: RequestOptions) {
    return execute(
      send,
      async (response) => {
        if (response.status !== 204)
          throw new RequestError({ code: "invalid_response" });
      },
      options,
    );
  }

  function requestBlob(send: RpcRequest, options?: RequestOptions) {
    return execute(send, (response) => response.blob(), options);
  }

  return { rpc, requestJson, requestJsonResponse, requestEmpty, requestBlob };
}

export const {
  rpc,
  requestJson,
  requestJsonResponse,
  requestEmpty,
  requestBlob,
} = createApiClient();
