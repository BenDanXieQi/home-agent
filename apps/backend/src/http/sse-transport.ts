import type { SSEMessage, SSEStreamingApi } from "hono/streaming";
import { addAbortListener } from "node:events";
import pTimeout from "p-timeout";

type Message = Omit<SSEMessage, "data"> & { data: string };

/** Counts the UTF-8 frame Hono writes, including multiline data prefixes. */
function messageBytes(message: Message) {
  const lines = message.data.split(/\r\n|\r|\n/);
  return (
    lines.reduce((bytes, line) => bytes + Buffer.byteLength(line) + 6, 0) +
    lines.length -
    1 +
    (message.event ? Buffer.byteLength(message.event) + 8 : 0) +
    (message.id !== undefined ? Buffer.byteLength(message.id) + 5 : 0) +
    (message.retry !== undefined ? String(message.retry).length + 8 : 0) +
    2
  );
}

/** One native FIFO owns writes, their budgets, and the client cancellation. */
export function createSseTransport(
  stream: SSEStreamingApi,
  options: {
    signal?: AbortSignal;
    heartbeat?: { intervalMs: number; message: () => Message };
    writeTimeoutMs: number;
    eventBytes: number;
    queuedBytes: number;
    queuedEvents: number;
  },
) {
  const controller = new AbortController();
  const done = Promise.withResolvers<void>();
  let closed = false;
  let queuedBytes = 0;
  let queuedEvents = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let externalAbort: ReturnType<typeof addAbortListener> | undefined;
  let queueController: WritableStreamDefaultController | undefined;
  const queue = new WritableStream<Message>({
    start(control) {
      queueController = control;
    },
    async write(message) {
      controller.signal.throwIfAborted();
      await pTimeout(stream.writeSSE(message), {
        milliseconds: options.writeTimeoutMs,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
    },
  });
  const writer = queue.getWriter();

  function close(
    reason: unknown = new DOMException("SSE closed", "AbortError"),
  ) {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    externalAbort?.[Symbol.dispose]();
    controller.abort(reason);
    queueController?.error(reason);
    stream.abort();
    done.resolve();
  }

  async function send(
    message: Message,
    delivery: { queued?: boolean; end?: boolean } = {},
  ) {
    controller.signal.throwIfAborted();
    const bytes = messageBytes(message);
    const counted = delivery.queued !== false;
    if (
      bytes > options.eventBytes ||
      (counted &&
        (queuedBytes + bytes > options.queuedBytes ||
          queuedEvents + 1 > options.queuedEvents))
    ) {
      const error = new Error("SSE transport budget exceeded");
      close(error);
      throw error;
    }
    if (counted) {
      queuedBytes += bytes;
      queuedEvents++;
    }
    try {
      await writer.write(message);
      if (delivery.end) close();
    } catch (error) {
      close(error);
      throw error;
    } finally {
      if (counted) {
        queuedBytes -= bytes;
        queuedEvents--;
      }
    }
  }

  function enqueue(...args: Parameters<typeof send>) {
    // Synchronous publishers delegate failed deliveries to the lifecycle owner.
    send(...args).catch(close);
  }

  writer.closed.catch(close);
  stream.onAbort(() => close());
  if (options.signal) {
    externalAbort = addAbortListener(options.signal, () => {
      close(options.signal?.reason);
    });
  }
  if (stream.aborted || options.signal?.aborted) close(options.signal?.reason);
  const heartbeatOptions = options.heartbeat;
  if (!closed && heartbeatOptions) {
    heartbeat = setInterval(() => {
      try {
        enqueue(heartbeatOptions.message());
      } catch (error) {
        close(error);
      }
    }, heartbeatOptions.intervalMs);
  }

  return {
    send,
    enqueue,
    signal: controller.signal,
    close,
    done: done.promise,
    get closed() {
      return closed;
    },
  };
}
