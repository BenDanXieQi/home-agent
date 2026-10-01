import { assign, createActor, setup } from "xstate";
import type { z } from "zod";
import type { perceptionConfigSchema } from "../config";
import type { runSchema, observationSchema } from "../observations";
import { createFfmpegDecoder } from "../media/ffmpeg-decoder";
import { createLatestFrame, type VideoFrame } from "../media/latest-frame";
import { createVideoMetrics } from "./metrics";

export function createVideoSource(options: {
  run: z.infer<typeof runSchema>;
  config: z.infer<typeof perceptionConfigSchema>;
  decoder: Omit<
    Parameters<typeof createFfmpegDecoder>[0],
    | "onFrame"
    | "sampleFps"
    | "firstFrameTimeoutMs"
    | "silenceTimeoutMs"
    | "onMedia"
  >;
  ready: () => void;
  media: Parameters<typeof createFfmpegDecoder>[0]["onMedia"];
  failure: (error: unknown) => void;
}) {
  const slot = createLatestFrame();
  const metrics = createVideoMetrics();
  const machine = setup({
    types: {
      // XState setup declares actor context and input event boundaries.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      context: {} as {
        sequence: number;
        inFlight: number | null;
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      events: {} as
        | { type: "FRAME"; frame: Omit<VideoFrame, "sequence"> }
        | { type: "SUBMIT"; sequence: number }
        | { type: "SETTLE" }
        | { type: "FAIL" }
        | { type: "STOP" }
        | { type: "CLOSED" },
    },
  }).createMachine({
    initial: "reading",
    context: { sequence: 0, inFlight: null },
    on: { STOP: { target: ".stopping" } },
    states: {
      reading: {
        on: {
          FRAME: {
            actions: [
              assign(({ context }) => ({ sequence: context.sequence + 1 })),
              ({ context, event }) => {
                metrics.values.complete++;
                metrics.values.sampled++;
                if (
                  slot.replace({ ...event.frame, sequence: context.sequence })
                )
                  metrics.values.replaced++;
                metrics.values.pending = 1;
                if (context.inFlight === null) options.ready();
              },
            ],
          },
          SUBMIT: {
            actions: assign(({ event }) => ({ inFlight: event.sequence })),
          },
          SETTLE: {
            actions: [
              assign({ inFlight: null }),
              () => {
                if (slot.ready) options.ready();
              },
            ],
          },
          FAIL: "failed",
        },
      },
      failed: {},
      stopping: { on: { CLOSED: "closed" } },
      closed: { type: "final" },
    },
  });
  const actor = createActor(machine).start();
  const decoder = createFfmpegDecoder({
    ...options.decoder,
    ...options.config,
    onMedia: options.media,
    onFrame(frame) {
      actor.send({
        type: "FRAME",
        frame: {
          ...frame,
          receivedAt: Date.now(),
          availableAt: performance.now(),
        },
      });
    },
  });
  decoder.completed.catch((error: unknown) => {
    if (!actor.getSnapshot().matches("reading")) return;
    actor.send({ type: "FAIL" });
    if (slot.clear()) metrics.values.discarded++;
    metrics.values.pending = 0;
    options.failure(error);
  });
  let closing: Promise<void> | undefined;
  return {
    maxFrameAgeMs: options.config.maxFrameAgeMs,
    run: options.run,
    metrics,
    get health() {
      return actor.getSnapshot().matches("reading")
        ? ("reading" as const)
        : ("failed" as const);
    },
    take() {
      if (
        !actor.getSnapshot().matches("reading") ||
        actor.getSnapshot().context.inFlight !== null
      )
        return undefined;
      const frame = slot.take();
      metrics.values.pending = 0;
      if (!frame) return undefined;
      const age = performance.now() - frame.availableAt;
      metrics.values.schedulingWaitMaxMs = Math.max(
        metrics.values.schedulingWaitMaxMs,
        age,
      );
      if (age >= options.config.maxFrameAgeMs) {
        metrics.values.expired++;
        metrics.age(age);
        return undefined;
      }
      actor.send({ type: "SUBMIT", sequence: frame.sequence });
      metrics.values.submitted++;
      metrics.values.inFlight = 1;
      return frame;
    },
    settle(success: boolean, frame: VideoFrame) {
      metrics.values[success ? "succeeded" : "failed"]++;
      metrics.values.inFlight = 0;
      metrics.age(performance.now() - frame.availableAt);
    },
    release() {
      if (actor.getSnapshot().status === "active")
        actor.send({ type: "SETTLE" });
    },
    observation(
      frame: VideoFrame,
      detections: z.infer<typeof observationSchema>["detections"],
    ) {
      return {
        run: options.run,
        sequence: frame.sequence,
        receivedAt: frame.receivedAt,
        sampledAt: frame.receivedAt,
        mediaTime: frame.mediaTime,
        width: frame.width,
        height: frame.height,
        coordinateBasis: "decoded_rgb24" as const,
        detections,
        ageMs: performance.now() - frame.availableAt,
      };
    },
    close() {
      actor.send({ type: "STOP" });
      if (slot.clear()) metrics.values.discarded++;
      metrics.values.pending = 0;
      closing ??= decoder.close().then(() => {
        actor.send({ type: "CLOSED" });
        actor.stop();
      });
      return closing;
    },
  };
}
