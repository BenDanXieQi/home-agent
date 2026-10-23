import {
  createBackendClient,
  type BackendClient,
} from "@home-agent/backend-client";
import { apiErrorSchema } from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import { consumeOperationStream } from "@home-agent/api/http/operation-stream";
import { ZodError } from "zod";
import {
  readResponseError,
  RequestError,
  type ClientErrorCode,
} from "./errors";

type RpcRequest<R extends Response = Response> = (
  client: BackendClient,
  options: { init: RequestInit },
) => Promise<R>;
type RpcJsonRequest<T> = RpcRequest<Response & { json(): Promise<T> }>;
type ResponseSchema<T> = { parse: (data: unknown) => T };
type RetryPolicy = {
  maxRetries: number;
  codes: readonly ClientErrorCode[];
};
export const retryOnceOnTransportFailure: RetryPolicy = {
  maxRetries: 1,
  codes: ["network_error", "request_timeout"],
};
type RequestOptions = {
  acceptedStatuses?: readonly number[];
  signal?: AbortSignal | undefined;
  timeoutMs?: number | null;
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
  if (error instanceof AppError)
    return new RequestError({
      code: error.code,
      message: error.message,
      ...error.details,
    });
  return new RequestError({
    code:
      error instanceof DOMException && error.name === "TimeoutError"
        ? "request_timeout"
        : error instanceof SyntaxError || error instanceof ZodError
          ? "invalid_response"
          : "network_error",
  });
}

const transport: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });
export const rpc = createBackendClient("/", { fetch: transport });

export async function requestOperationStream<Progress, Result>(
  send: RpcRequest,
  contract: Parameters<typeof consumeOperationStream<Progress, Result>>[0],
  options: Pick<RequestOptions, "signal" | "keepalive"> & {
    receive?: Parameters<typeof consumeOperationStream<Progress, Result>>[3];
  } = {},
) {
  const signal = options.signal ?? new AbortController().signal;
  try {
    return await consumeOperationStream(
      contract,
      (requestSignal) =>
        send(rpc, {
          init: {
            signal: requestSignal,
            ...(options.keepalive ? { keepalive: true } : {}),
          },
        }),
      signal,
      options.receive,
    );
  } catch (cause) {
    throw transportError(cause, signal);
  }
}

async function execute<R extends Response, T>(
  send: RpcRequest<R>,
  decode: (response: R) => Promise<T>,
  options: RequestOptions = {},
) {
  for (let attempt = 0; ; attempt++) {
    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      ...(options.timeoutMs === null
        ? []
        : [AbortSignal.timeout(options.timeoutMs ?? 12_000)]),
    ]);
    try {
      signal.throwIfAborted();
      const response = await send(rpc, {
        init: { signal, ...(options.keepalive ? { keepalive: true } : {}) },
      });
      if (!response.ok && !options.acceptedStatuses?.includes(response.status))
        throw await readResponseError(response);
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

export function requestJson<T>(
  send: RpcJsonRequest<T>,
  schema?: ResponseSchema<T>,
  options?: RequestOptions,
) {
  return execute(
    send,
    async (response) => {
      const payload: T = await response.json();
      if (!response.ok) {
        const error = apiErrorSchema.safeParse(payload);
        if (error.success) throw new RequestError(error.data, response.status);
      }
      if (!schema) return payload;
      try {
        return schema.parse(payload);
      } catch {
        throw new RequestError({ code: "invalid_response" });
      }
    },
    options,
  );
}

export function requestEmpty(send: RpcRequest, options?: RequestOptions) {
  return execute(
    send,
    async (response) => {
      if (response.status !== 204)
        throw new RequestError({ code: "invalid_response" });
    },
    options,
  );
}

export function requestBlob(send: RpcRequest, options?: RequestOptions) {
  return execute(send, (response) => response.blob(), options);
}
