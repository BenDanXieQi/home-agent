import type { windowFrameSchema } from "@home-agent/api/contracts";
import type { z } from "zod";
import type { frameSchema } from "../detection/frame";

export type VideoFrame = z.infer<typeof frameSchema> &
  Pick<
    z.infer<typeof windowFrameSchema>,
    "sequence" | "receivedAt" | "mediaTime"
  > & { availableAt: number };
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
