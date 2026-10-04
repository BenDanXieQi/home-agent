import { faceImagePreparation } from "./processing-version";
import sharp from "sharp";
import type { z } from "zod";
import type { trackingObservationSchema } from "@home-agent/api/contracts";
import profile from "./profile.json";
import { loadImage } from "../detection/image";
import type { imageRequestSchema } from "../detection/image-request";

// Registration and online matching use identical full-frame geometry and pixels.
export async function prepareIdentityFrame(
  observation: Pick<
    z.infer<typeof trackingObservationSchema>,
    "width" | "height"
  > & {
    tracks: Pick<
      z.infer<typeof trackingObservationSchema>["tracks"][number],
      "trackId" | "className" | "state" | "measuredBox"
    >[];
  },
  rgb: Uint8Array,
) {
  const scaleX = profile.width / observation.width;
  const scaleY = profile.height / observation.height;
  const input =
    scaleX === 1 && scaleY === 1
      ? Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength)
      : await sharp(rgb, {
          raw: {
            width: observation.width,
            height: observation.height,
            channels: 3,
          },
        })
          .timeout({ seconds: 1 })
          .resize(profile.width, profile.height, faceImagePreparation.camera)
          .raw()
          .toBuffer();
  return {
    rgb: new Uint8Array(input),
    tracks: observation.tracks.flatMap((track) => {
      const box = track.measuredBox;
      return track.state === "measured" && box
        ? [
            {
              trackId: track.trackId,
              className: track.className,
              measuredBox: {
                x: box.x * scaleX,
                y: box.y * scaleY,
                w: box.w * scaleX,
                h: box.h * scaleY,
              },
            },
          ]
        : [];
    }),
  };
}

// A still photograph has no camera geometry. Preserve its aspect ratio and the
// entire image so the single-face check cannot hide a second face by cropping.
export async function prepareFacePhoto(
  input: z.infer<typeof imageRequestSchema>,
) {
  const image = await loadImage({ path: input.path });
  const rgb = await sharp(image.frame.rgb, {
    raw: { width: image.frame.width, height: image.frame.height, channels: 3 },
  })
    .timeout({ seconds: 1 })
    .resize(profile.width, profile.height, faceImagePreparation.photo)
    .raw()
    .toBuffer();
  return new Uint8Array(rgb);
}
