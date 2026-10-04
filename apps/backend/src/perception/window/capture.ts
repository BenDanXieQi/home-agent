import { createHash } from "node:crypto";
import sharp from "sharp";
import type { z } from "zod";
import type { runSchema } from "../observations";
import type { VideoFrame } from "../media/latest-frame";
import type { windowFrameEventSchema, windowGapEventSchema } from "./protocol";
import { windowLimits } from "./limits";

sharp.concurrency(1);

// Capture owns its pixel copy before detection transfers the original buffer.
// No queue: at most two native resize operations across all camera channels.
export function createWindowCapture(
  emit: (
    event:
      | z.infer<typeof windowFrameEventSchema>
      | z.infer<typeof windowGapEventSchema>,
  ) => Promise<void>,
) {
  let active = 0;
  return (run: z.infer<typeof runSchema>) => {
    let lastPts = -Infinity,
      skipped = 0,
      stopped = false;
    let reporting = false;
    function report(
      reason: z.infer<typeof windowGapEventSchema>["reason"],
      at: number,
    ) {
      if (stopped || reporting) return;
      reporting = true;
      emit({ event: "window_gap", run, reason, at })
        .catch((error: unknown) => {
          console.error("Window gap publication failed", error);
        })
        .finally(() => {
          reporting = false;
        });
    }
    return {
      accept(frame: VideoFrame) {
        if (frame.mediaTime.pts < lastPts) {
          lastPts = -Infinity;
          skipped++;
        }
        if (
          stopped ||
          (frame.mediaTime.pts - lastPts) / 90 < windowLimits.sampleIntervalMs
        )
          return;
        if (active >= windowLimits.captureConcurrency) {
          skipped++;
          report("capture_capacity", frame.receivedAt);
          return;
        }
        // A rejected frame must not consume the source's sampling interval.
        lastPts = frame.mediaTime.pts;
        active++;
        const rgb = new Uint8Array(frame.rgb);
        const raw = {
          width: frame.width,
          height: frame.height,
          channels: 3 as const,
        };
        const scale = Math.min(
          windowLimits.shortSide / Math.min(frame.width, frame.height),
          windowLimits.longSide / Math.max(frame.width, frame.height),
        );
        const task = (async () => {
          const retained = await sharp(rgb, { raw })
            .timeout({ seconds: 2 })
            .resize(
              Math.max(2, Math.round(frame.width * scale)),
              Math.max(2, Math.round(frame.height * scale)),
            )
            .raw()
            .toBuffer({ resolveWithObject: true });
          const gray = await sharp(rgb, { raw })
            .timeout({ seconds: 2 })
            .resize(windowLimits.graySide, windowLimits.graySide, {
              fit: "fill",
            })
            .greyscale()
            .raw()
            .toBuffer();
          if (stopped) return;
          const omitted = skipped;
          skipped = 0;
          await emit({
            event: "window_frame",
            run,
            skipped: omitted,
            frame: {
              sequence: frame.sequence,
              receivedAt: frame.receivedAt,
              mediaTime: frame.mediaTime,
              fingerprint: {
                algorithm: "md5_rgb24",
                value: createHash("md5").update(rgb).digest("hex"),
                width: frame.width,
                height: frame.height,
              },
              width: frame.width,
              height: frame.height,
              retainedWidth: retained.info.width,
              retainedHeight: retained.info.height,
              rgb: retained.data,
              gray,
            },
          });
        })();
        task
          .catch((error: unknown) => {
            skipped++;
            console.error("Window capture failed", error);
            report("capture_failed", frame.receivedAt);
          })
          .finally(() => {
            active--;
          });
      },
      stop() {
        stopped = true;
      },
    };
  };
}
