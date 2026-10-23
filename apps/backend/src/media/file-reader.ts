import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { MediaResource } from "./resource";
import type { createMediaResources } from "./resources";

export function readMediaFile(
  item: MediaResource,
  path: string,
  signal: AbortSignal,
  options: Pick<
    Parameters<typeof createMediaResources>[0],
    "readMs" | "readChunkBytes" | "readTimeout"
  >,
  onClose: () => void,
  range?: { start: number; end: number },
) {
  const idle = options.readTimeout === "idle";
  const scoped = AbortSignal.any([
    signal,
    item.access.signal,
    ...(idle ? [] : [AbortSignal.timeout(options.readMs)]),
  ]);
  scoped.throwIfAborted();
  const fileOptions = {
    ...range,
    signal: scoped,
    highWaterMark: options.readChunkBytes,
  };

  // Start idle reads only when consumed; multipart responses may wait between files.
  async function* contents() {
    const file = createReadStream(path, fileOptions);
    const timer = setTimeout(() => {
      stream.destroy(new Error("Media read made no progress"));
    }, options.readMs);
    timer.unref();
    try {
      for await (const chunk of file) {
        timer.refresh();
        yield chunk;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const stream = idle
    ? Readable.from(contents(), {
        objectMode: false,
        highWaterMark: 0,
        signal: scoped,
      })
    : createReadStream(path, fileOptions);
  const finished = new Promise<void>((resolve) => {
    stream.once("close", () => {
      item.reads.delete(finished);
      onClose();
      resolve();
    });
  });
  item.reads.add(finished);
  return Readable.toWeb(stream, {
    strategy: new ByteLengthQueuingStrategy({
      highWaterMark: idle ? 0 : options.readChunkBytes,
    }),
  });
}
