import {
  EventSourceParserStream,
  type EventSourceMessage,
} from "eventsource-parser/stream";

type StreamResponse = Pick<
  Response,
  "body" | "bodyUsed" | "ok" | "headers" | "status"
>;

export async function consumeEventStream(
  options: {
    request: (signal: AbortSignal) => Promise<StreamResponse>;
    signal: AbortSignal;
    maxBufferSize: number;
    maxEventBytes?: number;
    firstEventTimeoutMs?: number;
    silenceMs: number;
    onResponse?: (response: StreamResponse) => void;
  },
  receive: (
    event: EventSourceMessage,
  ) => void | boolean | Promise<void | boolean>,
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function arm(ms: number) {
    clearTimeout(deadline);
    deadline = setTimeout(
      () =>
        controller.abort(
          new DOMException("Event stream deadline exceeded", "TimeoutError"),
        ),
      ms,
    );
  }
  arm(10_000);
  let response: StreamResponse | undefined;
  try {
    response = await options.request(signal);
    signal.throwIfAborted();
    options.onResponse?.(response);
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    )
      throw new Error("Event stream unavailable");
    if (options.firstEventTimeoutMs !== undefined)
      arm(options.firstEventTimeoutMs);
    const events = response.body
      .pipeThrough(new TextDecoderStream(), { signal })
      .pipeThrough(
        new EventSourceParserStream({
          maxBufferSize: options.maxBufferSize,
          onError: "terminate",
        }),
        { signal },
      );
    for await (const event of events) {
      signal.throwIfAborted();
      if (
        options.maxEventBytes !== undefined &&
        new TextEncoder().encode(event.data).byteLength > options.maxEventBytes
      )
        throw new Error("Oversized event");
      if ((await receive(event)) === false) break;
      arm(options.silenceMs);
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
    if (response?.body && !response.bodyUsed) await response.body.cancel();
  }
}
