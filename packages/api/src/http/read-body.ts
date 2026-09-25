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
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
) {
  const reader = response.body?.getReader();
  if (!reader) throw new ResponseBodyError("empty_response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    signal?.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) throw new ResponseBodyError("response_too_large");
      chunks.push(chunk.value.slice());
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* The transport may already have been aborted. */
    } finally {
      reader.releaseLock();
    }
  }
}

export async function readLimitedJson(
  response: Response,
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
