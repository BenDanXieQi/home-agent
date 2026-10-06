import {
  EventSourceParserStream,
  type EventSourceMessage,
} from "eventsource-parser/stream";

/** One HTTP stream; callers own reconnection and domain state. */
export async function consumeEventStream(
  options: {
    request: (signal: AbortSignal) => Promise<Response>;
    signal: AbortSignal;
    maxBufferSize: number;
    maxEventBytes?: number;
    firstEventTimeoutMs?: number;
    silenceMs: number;
    onResponse?: (response: Response) => void;
  },
  receive: (event: EventSourceMessage) => void,
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
  let response: Response | undefined;
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
    await response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new EventSourceParserStream({
          maxBufferSize: options.maxBufferSize,
          onError: "terminate",
        }),
      )
      .pipeTo(
        new WritableStream<EventSourceMessage>({
          write(event) {
            signal.throwIfAborted();
            if (
              options.maxEventBytes !== undefined &&
              new TextEncoder().encode(event.data).byteLength >
                options.maxEventBytes
            )
              throw new Error("Oversized event");
            receive(event);
            arm(options.silenceMs);
          },
        }),
        { signal },
      );
  } finally {
    clearTimeout(deadline);
    controller.abort();
    if (response?.body && !response.bodyUsed) await response.body.cancel();
  }
}
