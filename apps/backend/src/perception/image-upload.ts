import {
  imageLimits,
  imageDetectionResponseSchema,
} from "@home-agent/api/contracts";
import { createBoundedMediaUpload } from "../media/upload";
import type { createPerceptionService } from "./service";

export function createImageUpload(
  service: Pick<ReturnType<typeof createPerceptionService>, "detectImage">,
  shutdown: AbortSignal,
  timeoutMs: number,
) {
  return createBoundedMediaUpload(
    async ([file], signal) =>
      imageDetectionResponseSchema.parse(
        await service.detectImage({ path: file!.path }, signal),
      ),
    shutdown,
    timeoutMs,
    {
      maxBytes: imageLimits.maxFileBytes,
      invalidCode: "perception_image_invalid",
    },
  );
}
