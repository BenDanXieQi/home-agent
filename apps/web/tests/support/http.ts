import { vi } from "vitest";

export const fetchMock = vi.fn<typeof fetch>();

export function untilAborted(signal: AbortSignal | null | undefined) {
  if (!signal) throw new Error("Expected an abortable HTTP request");
  return new Promise<Response>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}

/** Native AbortSignal.timeout uses a runtime clock outside Vitest fake timers. */
export function useRequestClock() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((duration) => {
    const controller = new AbortController();
    setTimeout(
      () =>
        controller.abort(new DOMException("Deadline exceeded", "TimeoutError")),
      duration,
    );
    return controller.signal;
  });
}

export function requestAt(index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`Missing HTTP request ${index}`);
  const [input, init] = call;
  const url = input instanceof Request ? input.url : String(input);
  return {
    url: new URL(url, "http://web.test"),
    method: init?.method ?? "GET",
    body:
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : null,
    signal: init?.signal,
    keepalive: init?.keepalive,
  };
}

/** A real byte stream: cancellation behaves like fetch aborting its response body. */
export function eventStream(signal: AbortSignal | null | undefined) {
  if (!signal) throw new Error("An SSE connection must carry an AbortSignal");
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const abort = () => {
    if (ended) return;
    ended = true;
    controller.error(signal.reason);
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
    },
    cancel() {
      ended = true;
      signal.removeEventListener("abort", abort);
    },
  });
  return {
    signal,
    response: new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    }),
    bytes(value: Uint8Array) {
      controller.enqueue(value);
    },
    send(event: string, data: unknown) {
      controller.enqueue(
        new TextEncoder().encode(
          `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        ),
      );
    },
    end() {
      ended = true;
      signal.removeEventListener("abort", abort);
      controller.close();
    },
  };
}
