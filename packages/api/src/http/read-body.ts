export class ResponseBodyError extends Error {
  constructor(
    readonly code: "empty_response" | "response_too_large" | "invalid_json",
  ) {
    super(code);
    this.name = "ResponseBodyError";
  }
}

/** Bounded Web Streams consumption; transport/abort errors retain their identity. */
export async function readLimitedBytes(
  response: Pick<Response, "body">,
  maxBytes: number,
  signal?: AbortSignal,
) {
  if (!response.body) throw new ResponseBodyError("empty_response");
  let length = 0;
  const limited = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        length += chunk.byteLength;
        if (length > maxBytes)
          throw new ResponseBodyError("response_too_large");
        controller.enqueue(chunk);
      },
    }),
    signal ? { signal } : undefined,
  );
  // Native stream cancellation also interrupts a stalled read when the signal aborts.
  const bytes = await new Response(limited).arrayBuffer();
  signal?.throwIfAborted();
  return new Uint8Array(bytes);
}

export async function readLimitedJson(
  response: Parameters<typeof readLimitedBytes>[0],
  maxBytes: number,
  signal?: AbortSignal,
) {
  const bytes = await readLimitedBytes(response, maxBytes, signal);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new ResponseBodyError("invalid_json");
  }
}
