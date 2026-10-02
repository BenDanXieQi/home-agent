import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import type { z } from "zod";
import type {
  identityFrameSnapshotSchema,
  identityObservationSchema,
  trackingObservationSchema,
} from "@home-agent/api/contracts";
import type { runSchema } from "../observations";
import { createIdentityAnalysis } from "./analysis";
import { identityLimits, type identityConfigSchema } from "./config";
import { loadGallery } from "./gallery-file";
import { createFaceProcess, FaceProcessExitError } from "./process";
import profile from "./profile.json";

function createOwner(config: z.infer<typeof identityConfigSchema>) {
  return {
    config,
    gallery: null as Awaited<ReturnType<typeof loadGallery>>,
    referenceLoad: undefined as ReturnType<typeof loadGallery> | undefined,
    referencesReady: false,
    controller: new AbortController(),
    model: undefined as
      | Awaited<ReturnType<typeof createFaceProcess>>
      | undefined,
    creating: undefined as Promise<void> | undefined,
    pending: undefined as Promise<void> | undefined,
    unloading: undefined as Promise<void> | undefined,
    lastDemandAt: 0,
    error: undefined as string | undefined,
    retryAt: 0,
    reserved: false,
    retired: false,
  };
}
function createSource(
  run: z.infer<typeof runSchema>,
  config: z.infer<typeof identityConfigSchema>,
) {
  return {
    run,
    config,
    analysis: createIdentityAnalysis(config, null),
    generation: "",
    dimensions: "",
    sequence: 0,
    rtpTimestamp: -1,
    revision: 0,
    latest: undefined as
      | {
          observation: z.infer<typeof trackingObservationSchema>;
          availableAt: number;
          maxAgeMs: number;
        }
      | undefined,
    error: undefined as string | undefined,
    publishing: false,
    published: undefined as
      | Omit<z.infer<typeof identityObservationSchema>, "ageMs" | "revision">
      | undefined,
  };
}

function identityStatus(
  error: string | undefined,
  owner: ReturnType<typeof createOwner> | undefined,
) {
  if (error) return "unavailable" as const;
  if (owner?.unloading) return "unloading" as const;
  if (!owner?.model)
    return owner?.creating || owner?.reserved
      ? ("starting" as const)
      : ("idle" as const);
  return owner.gallery ? ("recognizing" as const) : ("collecting" as const);
}

function frameSnapshot(
  source: ReturnType<typeof createSource>,
  session: ReturnType<typeof createOwner>,
  inference: z.infer<typeof identityFrameSnapshotSchema>["inference"],
) {
  const error =
    source.error ??
    session.error ??
    (session.unloading ? undefined : session.model?.error);
  const { tracks } = source.analysis.snapshot(performance.now());
  return {
    status: identityStatus(error, session),
    evaluatedAt: Date.now(),
    inference,
    referenceRevision: session.gallery?.revision ?? null,
    tracks: tracks.map(
      ({
        trackId,
        state,
        label,
        reason,
        supportingSamples,
        score,
        margin,
        lastEvidenceAt,
        confirmedAt,
        expiresAt,
      }) => ({
        trackId,
        state,
        label,
        reason,
        supportingSamples,
        score,
        margin,
        lastEvidenceAt,
        confirmedAt,
        expiresAt,
      }),
    ),
  } satisfies z.infer<typeof identityFrameSnapshotSchema>;
}

export function createIdentityRuntime(options: {
  reserveCompute: () => boolean;
  releaseCompute: () => void;
  emit: (
    observation: z.infer<typeof identityObservationSchema>,
  ) => Promise<void>;
  failure: (error: unknown) => void;
  fatal: (error: unknown) => void;
}) {
  const sources = new Map<string, ReturnType<typeof createSource>>();
  let owner: ReturnType<typeof createOwner> | undefined;
  let cleaning: Promise<void> | undefined;
  let closed = false;
  const turns = new Map<string, number>();

  function releaseCompute(session: ReturnType<typeof createOwner>) {
    if (!session.reserved) return;
    session.reserved = false;
    options.releaseCompute();
  }
  function publish(source: ReturnType<typeof createSource>) {
    if (source.publishing) return;
    source.publishing = true;
    const deliver = async () => {
      if (sources.get(source.run.runId) === source) {
        if (closed) return;
        const latest = source.latest;
        if (
          !latest ||
          performance.now() - latest.availableAt >= latest.maxAgeMs
        )
          return;
        const observation = latest.observation;
        const error =
          source.error ??
          owner?.error ??
          (owner?.unloading ? undefined : owner?.model?.error);
        const value = {
          run: observation.run,
          sequence: observation.sequence,
          receivedAt: observation.receivedAt,
          sampledAt: observation.sampledAt,
          mediaTime: observation.mediaTime,
          width: observation.width,
          height: observation.height,
          coordinateBasis: observation.coordinateBasis,
          status: identityStatus(error, owner),
          error,
          referenceRevision: owner?.gallery?.revision ?? null,
          model: owner?.model?.metadata ?? null,
          ...source.analysis.snapshot(performance.now()),
        };
        if (isDeepStrictEqual(source.published, value)) return;
        await options.emit({
          ...value,
          ageMs: Math.max(0, performance.now() - latest.availableAt),
          revision: ++source.revision,
        });
        source.published = value;
      }
    };
    deliver()
      .catch(options.failure)
      .finally(() => {
        source.publishing = false;
      });
  }
  function ensureModel(session: ReturnType<typeof createOwner>) {
    if (
      session.retired ||
      session.model ||
      session.creating ||
      session.unloading ||
      cleaning ||
      performance.now() < session.retryAt
    )
      return;
    session.reserved = true;
    if (!options.reserveCompute()) {
      session.error =
        "Identity compute capacity unavailable; three CPU slots are required";
      return;
    }
    session.error = undefined;
    session.creating = (async () => {
      try {
        session.referenceLoad ??= loadGallery(
          session.config.galleryFile,
          session.config.minimumSharpness,
        );
        const gallery = await session.referenceLoad;
        if (session.retired) return;
        if (!session.referencesReady) {
          session.gallery = gallery;
          session.referencesReady = true;
          for (const source of sources.values())
            source.analysis.replaceReferences(gallery?.references ?? null);
        }
        const model = await createFaceProcess(
          session.config,
          session.controller.signal,
        );
        if (session.retired) {
          await model.close();
          return;
        }
        session.model = model;
      } catch (cause) {
        if (!session.retired) {
          session.error = String(cause).slice(0, 4096);
          session.retryAt = session.referencesReady
            ? performance.now() + identityLimits.restartDelayMs
            : Infinity;
        }
        if (cause instanceof FaceProcessExitError) {
          session.retryAt = Infinity;
          options.fatal(cause);
        } else releaseCompute(session);
      } finally {
        session.creating = undefined;
      }
    })();
  }
  function unload(session: ReturnType<typeof createOwner>) {
    if (session.unloading || session.pending || session.creating) return;
    const model = session.model;
    if (!model) {
      releaseCompute(session);
      return;
    }
    session.unloading = (async () => {
      try {
        await model.close();
        if (session.model === model) session.model = undefined;
        releaseCompute(session);
      } catch (cause) {
        // Keep both process ownership and capacity until exit is confirmed.
        session.error = String(cause).slice(0, 4096);
        session.retryAt = Infinity;
        options.fatal(cause);
      } finally {
        session.unloading = undefined;
      }
    })();
  }
  async function retire(session: ReturnType<typeof createOwner>) {
    session.retired = true;
    session.controller.abort(new Error("Identity session stopped"));
    await session.creating;
    await session.unloading;
    // Closing first interrupts a stalled inference before waiting for its owner.
    try {
      await session.model?.close();
    } catch (cause) {
      options.fatal(cause);
      throw cause;
    }
    await session.pending;
    releaseCompute(session);
  }
  const expiry = setInterval(() => {
    if (
      owner &&
      !owner.retired &&
      owner.retryAt !== Infinity &&
      performance.now() - owner.lastDemandAt >= owner.config.idleUnloadMs
    )
      unload(owner);
    for (const source of sources.values()) publish(source);
  }, 500);

  return {
    start(
      run: z.infer<typeof runSchema>,
      config: z.infer<typeof identityConfigSchema> | null,
    ) {
      if (!config || closed) return;
      if (owner && JSON.stringify(owner.config) !== JSON.stringify(config))
        throw new Error("Active identity sources must share one configuration");
      owner ??= createOwner(config);
      sources.set(run.runId, createSource(run, config));
    },
    observe(
      observation: z.infer<typeof trackingObservationSchema>,
      rgb: Uint8Array | undefined,
      availableAt: number,
      maxAgeMs: number,
    ) {
      const source = sources.get(observation.run.runId);
      const session = owner;
      if (!source && !closed)
        return {
          status: "disabled" as const,
          evaluatedAt: Date.now(),
          inference: "not_requested" as const,
          referenceRevision: null,
          tracks: [],
        } satisfies z.infer<typeof identityFrameSnapshotSchema>;
      if (
        !source ||
        !session ||
        session.retired ||
        closed ||
        observation.sequence <= source.sequence
      )
        return undefined;
      const now = performance.now();
      for (const [id, deadline] of turns) if (deadline <= now) turns.delete(id);
      if (now - availableAt >= maxAgeMs) return undefined;
      const dimensions = `${observation.width}:${observation.height}`;
      if (
        source.generation !== observation.mediaTime.generation ||
        source.dimensions !== dimensions ||
        observation.status === "failed"
      ) {
        source.analysis = createIdentityAnalysis(
          source.config,
          session.gallery?.references ?? null,
        );
        source.generation = observation.mediaTime.generation;
        source.dimensions = dimensions;
        source.rtpTimestamp = -1;
      }
      source.sequence = observation.sequence;
      source.latest = { observation, availableAt, maxAgeMs };
      source.error =
        observation.status === "failed" ? "Tracking unavailable" : undefined;
      const repeated =
        source.rtpTimestamp === observation.mediaTime.rtpTimestamp;
      source.rtpTimestamp = observation.mediaTime.rtpTimestamp;
      const targets = source.analysis.observe(
        observation.tracks,
        availableAt,
        observation.receivedAt,
      );
      if (observation.omittedHumans > 0) {
        source.analysis.skipped("coverage");
        turns.delete(source.run.runId);
        return frameSnapshot(source, session, "not_requested");
      }
      if (source.error || repeated || !targets.length) {
        turns.delete(source.run.runId);
        return frameSnapshot(source, session, "not_requested");
      }
      if (!rgb) {
        turns.delete(source.run.runId);
        source.analysis.skipped("pixels");
        return frameSnapshot(source, session, "not_requested");
      }
      session.lastDemandAt = now;
      ensureModel(session);
      turns.set(source.run.runId, availableAt + maxAgeMs);
      if (
        !session.model ||
        session.unloading ||
        session.pending ||
        turns.keys().next().value !== source.run.runId ||
        session.retryAt === Infinity
      ) {
        source.analysis.skipped("busy");
        return frameSnapshot(source, session, "not_requested");
      }
      turns.delete(source.run.runId);
      const model = session.model;
      const analysis = source.analysis;
      // Keep the tracking-owned pixel buffer alive for this one admitted resize.
      const pixels = rgb;
      analysis.admitted(targets, availableAt);
      session.pending = (async () => {
        try {
          const scaleX = profile.width / observation.width;
          const scaleY = profile.height / observation.height;
          const input =
            scaleX === 1 && scaleY === 1
              ? Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)
              : await sharp(pixels, {
                  raw: {
                    width: observation.width,
                    height: observation.height,
                    channels: 3,
                  },
                })
                  .timeout({ seconds: 1 })
                  .resize(profile.width, profile.height, {
                    fit: "fill",
                    kernel: "lanczos3",
                  })
                  .raw()
                  .toBuffer();
          if (
            session.retired ||
            closed ||
            sources.get(source.run.runId) !== source ||
            source.analysis !== analysis ||
            performance.now() - availableAt >= maxAgeMs
          )
            return;
          const request = {
            rgb: input.toString("base64"),
            tracks: observation.tracks.flatMap((track) => {
              const box = track.measuredBox;
              return track.className === "human" &&
                track.state === "measured" &&
                box
                ? [
                    {
                      trackId: track.trackId,
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
            targets,
            minimumSharpness: source.config.minimumSharpness,
          };
          const result = await model.extract(
            request,
            Math.max(
              1,
              Math.min(
                identityLimits.requestTimeoutMs,
                maxAgeMs - (performance.now() - availableAt),
              ),
            ),
          );
          if (
            session.retired ||
            closed ||
            sources.get(source.run.runId) !== source ||
            source.analysis !== analysis ||
            performance.now() - availableAt >= maxAgeMs
          )
            return;
          analysis.accept(result, availableAt, observation.receivedAt);
        } catch (cause) {
          session.error = String(cause).slice(0, 4096);
          session.retryAt = performance.now() + identityLimits.restartDelayMs;
          try {
            await model.close();
          } catch (closeError) {
            session.error = String(closeError).slice(0, 4096);
            session.retryAt = Infinity;
            options.fatal(closeError);
            return;
          }
          if (session.model === model) session.model = undefined;
          releaseCompute(session);
        } finally {
          session.pending = undefined;
        }
      })();
      // Freeze only what was known when tracking completed. This frame's native
      // result may inform later frames, but never rewrites this historical view.
      return frameSnapshot(source, session, "pending");
    },
    async stop(runId: string) {
      sources.delete(runId);
      turns.delete(runId);
      if (sources.size || !owner) return;
      const session = owner;
      owner = undefined;
      session.retired = true;
      session.controller.abort(new Error("Identity source stopped"));
      const previous = cleaning;
      const cleanup = (async () => {
        await previous;
        await retire(session);
      })();
      cleaning = cleanup;
      try {
        await cleanup;
      } finally {
        if (cleaning === cleanup) cleaning = undefined;
      }
    },
    async close() {
      closed = true;
      clearInterval(expiry);
      sources.clear();
      turns.clear();
      const session = owner;
      owner = undefined;
      await cleaning;
      if (session) await retire(session);
    },
  };
}
