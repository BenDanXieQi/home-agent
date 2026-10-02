import { createWindowCapture } from "../window/capture";
import type { createIdentityRuntime } from "../identity/runtime";
import { ComputeBusyError } from "../compute/protocol";
import type { createTrackingRuntime } from "../tracking/runtime";
import type { z } from "zod";
import type { videoEventSchema } from "./events";
import type { frameSchema } from "../detection/frame";
import type { observationSchema } from "../observations";
import { createVideoSource } from "./source";
import { createVideoScheduler } from "./scheduler";

// Dependencies are composed by process-entry; video does not import a pool implementation.
export function createVideoRuntime(dependencies: {
  identity: ReturnType<typeof createIdentityRuntime>;
  tracking: ReturnType<typeof createTrackingRuntime>;
  compute: {
    readonly available: boolean;
    detect: (
      frame: z.infer<typeof frameSchema>,
      onAdmitted: () => Promise<void>,
    ) => Promise<{
      detections: z.infer<typeof observationSchema>["detections"];
    }>;
    subscribeAvailable: (
      listener: () => void,
      waiting: () => boolean,
    ) => () => void;
  };
  emit: (event: z.infer<typeof videoEventSchema>) => Promise<void>;
  fatal: (error: unknown) => void;
}) {
  const sources = new Map<string, ReturnType<typeof createVideoSource>>();
  const capture = createWindowCapture(dependencies.emit);
  let closing = false;
  const pendingDispatches = new Set<Promise<void>>();
  const scheduler = createVideoScheduler(
    () => !closing && dependencies.compute.available,
    (id) => {
      const source = sources.get(id);
      const frame = source?.take();
      if (!source || !frame) return;
      const tracking = dependencies.tracking.capture(
        source.run,
        frame,
        source.maxFrameAgeMs,
        (observation, rgb) => {
          if (sources.get(id) === source && source.health === "reading") {
            const identity = dependencies.identity.observe(
              observation,
              rgb,
              frame.availableAt,
              source.maxFrameAgeMs,
            );
            if (identity)
              dependencies
                .emit({
                  event: "identity_frame",
                  run: observation.run,
                  frame: {
                    sequence: observation.sequence,
                    receivedAt: observation.receivedAt,
                    mediaTime: observation.mediaTime,
                    width: observation.width,
                    height: observation.height,
                  },
                  identity,
                })
                .catch(dependencies.fatal);
          }
        },
      );
      let trackingStarted = false;
      const pending = (async () => {
        let success = false;
        try {
          const result = await dependencies.compute.detect(frame, () =>
            dependencies.emit({
              event: "submitted",
              metrics: source.metrics.snapshot(),
              run: source.run,
              sequence: frame.sequence,
            }),
          );
          success = true;
          source.settle(true, frame);
          await dependencies.emit({
            event: "settled",
            metrics: source.metrics.snapshot(),
            run: source.run,
            sequence: frame.sequence,
            ...(sources.get(id) === source && source.health === "reading"
              ? { observation: source.observation(frame, result.detections) }
              : {}),
          });
          if (sources.get(id) === source && source.health === "reading") {
            tracking?.complete(result.detections);
            trackingStarted = true;
          }
        } catch (error) {
          dependencies.fatal(error);
        } finally {
          if (!trackingStarted) tracking?.release();
          if (!success) source.settle(false, frame);
          source.release();
          scheduler.wake();
        }
      })().catch(dependencies.fatal);
      pendingDispatches.add(pending);
      pending.then(() => {
        pendingDispatches.delete(pending);
      }, dependencies.fatal);
    },
  );
  const unsubscribe = dependencies.compute.subscribeAvailable(
    scheduler.wake,
    () => scheduler.pending,
  );
  let reporting = false;
  const timer = setInterval(() => {
    if (reporting || closing) return;
    reporting = true;
    Promise.all(
      [...sources.values()].map((source) =>
        dependencies.emit({
          event: "health",
          run: source.run,
          status: source.health,
          metrics: source.metrics.snapshot(),
        }),
      ),
    )
      .catch(dependencies.fatal)
      .finally(() => {
        reporting = false;
      });
  }, 1000);
  return {
    start(
      input: Pick<
        Parameters<typeof createVideoSource>[0],
        "run" | "config" | "decoder"
      >,
    ) {
      if (closing || sources.size >= 8 || sources.has(input.run.runId))
        throw new ComputeBusyError("Video source capacity unavailable");
      const captured = capture(input.run);
      dependencies.identity.start(input.run, input.config.identity);
      const source = createVideoSource({
        capture: captured,
        run: input.run,
        config: input.config,
        decoder: input.decoder,
        media: (media) => {
          dependencies
            .emit({ event: "media", run: input.run, media })
            .catch(dependencies.fatal);
        },
        ready: () => scheduler.ready(input.run.runId),
        failure: (error) => {
          scheduler.remove(input.run.runId);
          Promise.all([
            dependencies.tracking.stop(input.run.runId),
            dependencies.identity.stop(input.run.runId),
          ]).catch(dependencies.fatal);
          dependencies
            .emit({
              event: "health",
              run: input.run,
              status: "failed",
              error: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 4096),
              metrics: source.metrics.snapshot(),
            })
            .catch(dependencies.fatal);
        },
      });
      sources.set(input.run.runId, source);
      dependencies.tracking.start(input.run);
    },
    async stop(id: string) {
      const source = sources.get(id);
      if (!source) return;
      scheduler.remove(id);
      await Promise.all([
        dependencies.tracking.stop(id),
        dependencies.identity.stop(id),
        source.close(),
      ]);
      // Retiring instances still consume decoder capacity until exit is confirmed.
      if (sources.get(id) === source) sources.delete(id);
    },
    async close() {
      closing = true;
      clearInterval(timer);
      unsubscribe();
      const owned = [...sources.values()];
      sources.clear();
      await Promise.all([
        dependencies.identity.close(),
        (async () => {
          await Promise.all(owned.map((source) => source.close()));
          await Promise.all(pendingDispatches);
          await dependencies.tracking.close();
        })(),
      ]);
    },
  };
}
