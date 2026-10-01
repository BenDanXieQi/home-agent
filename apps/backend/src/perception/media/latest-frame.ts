import type { mediaFrameTimeSchema } from "@home-agent/api/contracts";
import type { z } from "zod";
import type { frameSchema } from "../detection/frame";

export type VideoFrame = z.infer<typeof frameSchema> & {
  sequence: number;
  receivedAt: number;
  availableAt: number;
  mediaTime: z.infer<typeof mediaFrameTimeSchema>;
};
export function createLatestFrame() {
  let current: VideoFrame | undefined;
  return {
    replace(frame: VideoFrame) {
      const replaced = current !== undefined;
      current = frame;
      return replaced;
    },
    take() {
      const frame = current;
      current = undefined;
      return frame;
    },
    clear() {
      const retained = current !== undefined;
      current = undefined;
      return retained;
    },
    get ready() {
      return current !== undefined;
    },
  };
}
