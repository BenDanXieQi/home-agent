import { threadId } from "node:worker_threads";
import type { z } from "zod";
import { createDetector } from "../detection/detector";
import { errorDetails, taskSchema } from "./protocol";
import { detectImage } from "../detection/image";
import { ImageProcessingError } from "../detection/image-request";
import { fingerprintModel } from "../detection/model";

const asset = await fingerprintModel();
const detector = await createDetector();
// Requests are validated by the IPC receiver before thread dispatch.
export default async function run(task: z.infer<typeof taskSchema>) {
  const started = performance.now();
  switch (task.kind) {
    case "initialize":
      return {
        kind: "initialized" as const,
        metadata: { ...detector.metadata, ...asset, workerThreadId: threadId },
      };
    case "detect": {
      const result = await detector.detect(task.frame);
      return {
        kind: "detected" as const,
        ...result,
        timing: {
          ...result.timing,
          readMs: 0,
          decodeMs: 0,
          workerMs: performance.now() - started,
        },
      };
    }
    case "detect_image": {
      try {
        const result = await detectImage(detector, task.image);
        return {
          kind: "image_detected" as const,
          ...result,
          timing: {
            ...result.timing,
            workerMs: performance.now() - started,
          },
        };
      } catch (error) {
        if (!(error instanceof ImageProcessingError)) throw error;
        // Error structured-cloning omits custom properties such as code.
        return {
          kind: "image_failed" as const,
          ...errorDetails(error),
          code: error.code,
        };
      }
    }
    case "close":
      await detector.close();
      return { kind: "closed" as const };
    default:
      throw new Error("Unsupported computation task");
  }
}
