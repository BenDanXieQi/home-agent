import { addAbortListener } from "node:events";
import type { Context, Env } from "hono";
import { streamSSE } from "hono/streaming";
import { AppError, errorPayload } from "../errors";
import { trackHttpStream, currentTraceId } from "@home-agent/observability";

/** HTTP adaptation for one operation with progress and one terminal result. */
export function streamOperation<E extends Env>(
  c: Context<E>,
  run: (
    signal: AbortSignal,
    receive: (
      progress: unknown,
      operationSignal?: AbortSignal,
    ) => Promise<void>,
  ) => Promise<unknown>,
  publicError: (error: unknown) => AppError = (error) =>
    error instanceof AppError
      ? error
      : new AppError("internal_error", { cause: error }),
) {
  const completion = Promise.withResolvers<void>();
  trackHttpStream(completion.promise);
  c.header("Cache-Control", "no-store");
  c.header("X-Accel-Buffering", "no");
  const response = streamSSE(c, async (stream) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, controller.signal]);
    stream.onAbort(() => controller.abort());
    const abortSubscription = addAbortListener(signal, () => stream.abort());
    const send = async (event: string, data: unknown) => {
      signal.throwIfAborted();
      const delivery = AbortSignal.timeout(30_000);
      const deliveryCancellation = addAbortListener(delivery, () => {
        controller.abort(delivery.reason);
      });
      try {
        await stream.writeSSE({ event, data: JSON.stringify(data) });
        signal.throwIfAborted();
      } finally {
        deliveryCancellation[Symbol.dispose]();
      }
    };
    const heartbeat = setInterval(() => {
      send("heartbeat", null).catch((error: unknown) =>
        controller.abort(error),
      );
    }, 15_000);
    try {
      await send("heartbeat", null);
      const result = await run(signal, async (progress, operationSignal) => {
        operationSignal?.throwIfAborted();
        const deliveryCancellation = operationSignal
          ? addAbortListener(operationSignal, () => stream.abort())
          : undefined;
        try {
          await send("progress", progress);
        } finally {
          deliveryCancellation?.[Symbol.dispose]();
        }
      });
      clearInterval(heartbeat);
      await send("result", result);
    } catch (error) {
      clearInterval(heartbeat);
      if (!signal.aborted)
        await send("error", errorPayload(publicError(error), currentTraceId()));
    } finally {
      clearInterval(heartbeat);
      abortSubscription[Symbol.dispose]();
      controller.abort();
      completion.resolve();
    }
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
