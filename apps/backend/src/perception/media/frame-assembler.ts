import type { z } from "zod";
import type { frameSchema } from "../detection/frame";
import { frameLimits } from "../detection/frame";

// FFmpeg's PPM image2pipe output: ASCII P6 header followed by packed RGB24.
// Owns at most one partial image and a 128-byte header; no concatenated stream cache.
export function createFrameAssembler(
  onFrame: (frame: z.infer<typeof frameSchema>) => void,
) {
  let header = "";
  let width = 0;
  let height = 0;
  let pixels: z.infer<typeof frameSchema>["rgb"] | undefined;
  let offset = 0;
  return {
    push(chunk: Uint8Array) {
      let index = 0;
      while (index < chunk.length) {
        if (!pixels) {
          header += String.fromCharCode(chunk[index++]!);
          if (header.length > 128) throw new Error("Invalid RGB frame header");
          const match = /^P6\n(\d+) (\d+)\n255\n$/.exec(header);
          if (!match) continue;
          width = Number(match[1]);
          height = Number(match[2]);
          if (
            !width ||
            !height ||
            width > frameLimits.maxDimension ||
            height > frameLimits.maxDimension ||
            width * height > frameLimits.maxPixels
          )
            throw new Error("Decoded frame exceeds P0 frame limits");
          pixels = new Uint8Array(width * height * 3);
          offset = 0;
          header = "";
        }
        const count = Math.min(pixels.length - offset, chunk.length - index);
        pixels.set(chunk.subarray(index, index + count), offset);
        offset += count;
        index += count;
        if (offset === pixels.length) {
          const rgb = pixels;
          pixels = undefined;
          offset = 0;
          onFrame({ width, height, rgb });
        }
      }
    },
    clear() {
      pixels = undefined;
      header = "";
      offset = 0;
    },
  };
}
