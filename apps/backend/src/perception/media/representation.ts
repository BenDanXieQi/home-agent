import type { z } from "zod";
import type {
  mediaSelectionSchema,
  windowSummarySchema,
} from "@home-agent/api/contracts";

export function representationParameters(
  summary: Pick<
    z.infer<typeof windowSummarySchema>,
    "crop" | "frames" | "audio" | "startedAt" | "endedAt"
  >,
  selection: z.infer<typeof mediaSelectionSchema>,
) {
  const { representation, includeAudio } = selection;
  const crop = representation.startsWith("crop_") ? summary.crop : null;
  const audioUsable = summary.audio.status === "available";
  const selected =
    representation === "audio"
      ? []
      : representation.endsWith("image")
        ? summary.frames.slice(-1)
        : summary.frames;
  const audioIncluded =
    audioUsable &&
    (representation === "audio" ||
      (representation.endsWith("video") && includeAudio));
  const first = selected[0];
  const region =
    first && crop
      ? rectangle(crop, first.retainedWidth, first.retainedHeight)
      : null;
  const mappedCrop =
    first && region
      ? {
          x: region.left / first.retainedWidth,
          y: region.top / first.retainedHeight,
          w: region.width / first.retainedWidth,
          h: region.height / first.retainedHeight,
        }
      : null;
  const scale =
    first && region
      ? Math.min(
          first.retainedWidth / region.width,
          first.retainedHeight / region.height,
        )
      : 1;
  const width = first
    ? Math.max(
        2,
        Math.floor(((region?.width ?? first.retainedWidth) * scale) / 2) * 2,
      )
    : null;
  const height = first
    ? Math.max(
        2,
        Math.floor(((region?.height ?? first.retainedHeight) * scale) / 2) * 2,
      )
    : null;
  const startedAt = Math.min(
    first?.receivedAt ?? Infinity,
    audioIncluded ? (summary.audio.startedAt ?? Infinity) : Infinity,
  );
  const endedAt = Math.max(
    selected.at(-1)?.receivedAt ?? -Infinity,
    audioIncluded ? (summary.audio.endedAt ?? -Infinity) : -Infinity,
  );
  const basis = mappedCrop ?? { x: 0, y: 0, w: 1, h: 1 };
  return {
    shortSide: 512 as const,
    sampleFps: 1 as const,
    timestampBasis: "host_receive" as const,
    crop: mappedCrop,
    cropPixels: region,
    audioIncluded,
    startedAt: Number.isFinite(startedAt) ? startedAt : summary.startedAt,
    endedAt: Number.isFinite(endedAt) ? endedAt : summary.endedAt,
    width,
    height,
    coordinateBasis: "encoded_pixels" as const,
    frames: selected.map((frame) => ({
      sequence: frame.sequence,
      offsetMs: frame.receivedAt - startedAt,
      identity: frame.identity,
      detections:
        frame.detections?.flatMap((box) => {
          const x = Math.max(
            0,
            Math.floor(((box.x / frame.width - basis.x) / basis.w) * width!),
          );
          const y = Math.max(
            0,
            Math.floor(((box.y / frame.height - basis.y) / basis.h) * height!),
          );
          const right = Math.min(
            width!,
            Math.ceil(
              (((box.x + box.w) / frame.width - basis.x) / basis.w) * width!,
            ),
          );
          const bottom = Math.min(
            height!,
            Math.ceil(
              (((box.y + box.h) / frame.height - basis.y) / basis.h) * height!,
            ),
          );
          return right > x && bottom > y
            ? [{ ...box, x, y, w: right - x, h: bottom - y }]
            : [];
        }) ?? null,
    })),
  };
}
function rectangle(
  crop: NonNullable<z.infer<typeof windowSummarySchema>["crop"]>,
  width: number,
  height: number,
) {
  const left = Math.max(0, Math.floor(crop.x * width)),
    top = Math.max(0, Math.floor(crop.y * height));
  return {
    left,
    top,
    width: Math.max(1, Math.min(width - left, Math.ceil(crop.w * width))),
    height: Math.max(1, Math.min(height - top, Math.ceil(crop.h * height))),
  };
}
