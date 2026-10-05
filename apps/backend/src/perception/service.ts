import { createMemberAssociations } from "../household/identity/associations";
import type { createAppearanceIdentity } from "../household/identity/appearance";
import { identityLimits } from "./identity/config";
import { reidSha256, reidProcessingVersion } from "./tracking/feature-version";
import { identityReferenceVersionsSchema } from "@home-agent/api/contracts";
import type { createIdentityMatching } from "../household/identity/matching";
import { identityProcessingVersions } from "./identity/processing-version";
import type { z } from "zod";
import type { enrollmentCommandSchema } from "./identity/enrollment-protocol";
import { dirname, join } from "node:path";
import { createWindowStore } from "./window/store";
import { createWindowMedia } from "./media/window-media";
import type { createSpeechInbox } from "../conversation/speech-inbox";
import { planPerceptionResources } from "./compute/resources";
import { prepareSourceLease } from "./source-lease";
import { createAudioService } from "./audio/service";
import { errorDetails } from "./compute/protocol";
import pTimeout from "p-timeout";
import type { PerceptionSources } from "./sources";
import { readPerceptionConfig } from "./config-file";
import { perceptionConfigSchema, sourceKey } from "./config";
import { createDetectionPool, DetectionPoolError } from "./compute/pool";
import { createObservationStore } from "./observation-store";

// Capture belongs to the backend; browser viewing and freezing do not own its lifetime.
export function createPerceptionService(options: {
  identityReferences?:
    | Pick<
        ReturnType<typeof createIdentityMatching>,
        | "configure"
        | "snapshot"
        | "subscribe"
        | "associate"
        | "member"
        | "petCandidates"
      >
    | undefined;
  appearance?: ReturnType<typeof createAppearanceIdentity>;
  configPath: string;
  executable: string;
  sources: PerceptionSources;
  speechInbox?: Pick<
    ReturnType<typeof createSpeechInbox>,
    "configure" | "authorize" | "revoke" | "accept"
  >;
}) {
  const instanceId = crypto.randomUUID();
  let householdVersion:
    | Parameters<Parameters<typeof options.sources.subscribe>[0]>[0]
    | null = null;
  let sequence = 0;
  let config = perceptionConfigSchema.parse({});
  let resources: ReturnType<typeof planPerceptionResources> | undefined;
  let store = createObservationStore(config.maxFrameAgeMs);
  let pool: Awaited<ReturnType<typeof createDetectionPool>> | undefined;
  let status:
    | "starting"
    | "disabled"
    | "running"
    | "recovering"
    | "unavailable"
    | "closed" = "starting";
  let error: string | undefined;
  let stopped = false;
  let initializing: Promise<void> | undefined;
  let creatingPool:
    | Promise<Awaited<ReturnType<typeof createDetectionPool>>>
    | undefined;
  let closing: Promise<void> | undefined;
  let configRead = false;
  let identityConfigured = false;
  let configurationError: unknown;
  let computeId: number | undefined;
  const listeners = new Set<() => void>();
  const shutdown = new AbortController();
  const desired = new Map<
    string,
    {
      runId: string;
      identity: string;
      controller: AbortController;
      pending: Promise<void>;
      authorizedAt: NonNullable<
        ReturnType<typeof options.sources.eligibility>
      >["householdVersion"];
    }
  >();
  const retryAfter = new Map<string, number>();
  const cleanup = new Set<Promise<void>>();
  const associations = createMemberAssociations(
    options.identityReferences,
    options.appearance,
  );
  let publicationDepth = 0;
  let publicationPending = false;
  const changed = () => {
    if (publicationDepth) {
      publicationPending = true;
      return;
    }
    updateAssociations();
    sequence++;
    for (const listener of listeners) listener();
  };
  function publishTogether(action: () => void) {
    publicationDepth++;
    try {
      action();
    } finally {
      publicationDepth--;
      if (!publicationDepth && publicationPending) {
        publicationPending = false;
        changed();
      }
    }
  }
  const windows = createWindowStore({
    config: () => config,
    authorized: (run, identity) => {
      const access = options.sources.eligibility(run);
      return (
        access?.identity === identity && access.scopeEpoch === run.scopeEpoch
      );
    },
  });
  const media = createWindowMedia(
    windows,
    options.executable,
    join(dirname(options.configPath), "runtime", "perception-clips"),
  );
  let referenceSnapshot = options.identityReferences?.snapshot() ?? null;
  let referenceDelivery: Promise<void> | undefined;
  let deliveredReferences = "";
  function referenceVersion(value: typeof referenceSnapshot) {
    return value
      ? JSON.stringify(identityReferenceVersionsSchema.parse(value))
      : "null";
  }
  function syncIdentityReferences() {
    const compute = pool;
    if (!compute || compute.getStatus().status !== "ready" || referenceDelivery)
      return;
    const key = `${compute.getStatus().processId}:${referenceVersion(referenceSnapshot)}`;
    if (key === deliveredReferences) return;
    const next = referenceSnapshot;
    referenceDelivery = compute
      .identityReferences(next)
      .then(() => {
        deliveredReferences = key;
      })
      .catch((cause) => {
        console.error("Identity reference delivery failed", cause);
      })
      .finally(() => {
        referenceDelivery = undefined;
      });
  }
  options.appearance?.replaceReferences(performance.now());
  const unsubscribeAppearance = options.appearance?.subscribe(changed);
  const unsubscribeReferences = options.identityReferences?.subscribe(() =>
    publishTogether(() => {
      const previousVersion = referenceVersion(referenceSnapshot);
      referenceSnapshot = options.identityReferences?.snapshot() ?? null;
      if (previousVersion !== referenceVersion(referenceSnapshot)) {
        options.appearance?.replaceReferences(performance.now());
        store.invalidateIdentity();
      } else changed();
      syncIdentityReferences();
    }),
  );
  const unsubscribeWindows = windows.subscribe(media.capture);
  const audio = createAudioService({
    retainSpeech(observation) {
      windows.speech(observation, Date.now());
    },
    media: (track, pcm) => {
      windows.audio(track, pcm);
    },
    ...(options.speechInbox ? { speechInbox: options.speechInbox } : {}),
    sources: options.sources,
    executable: options.executable,
    changed,
  });
  let unsubscribeStore = store.subscribe(changed);
  function retire(key: string, reason: string) {
    publishTogether(() => {
      const entry = desired.get(key);
      if (!entry) return;
      options.appearance?.stop(entry.runId);
      windows.stopVideo(entry.runId);
      store.revoke(key, reason);
      desired.delete(key);
      entry.controller.abort();
      const owned = pool;
      const task = entry.pending
        .then(async () => {
          if (owned?.getStatus().status === "ready")
            await owned.stopVideo(entry.runId);
        })
        .catch((cause: unknown) => {
          error = errorDetails(cause).message;
          changed();
        });
      cleanup.add(task);
      task.then(
        () => {
          cleanup.delete(task);
          changed();
        },
        (cause: unknown) => {
          error = errorDetails(cause).message;
          changed();
        },
      );
    });
  }
  function reconcile() {
    if (stopped) return;
    syncIdentityReferences();
    options.appearance?.tick(performance.now());
    windows.tick(Date.now());
    media.prune();
    const selected =
      config.sources === "household" ? options.sources.list() : config.sources;
    windows.reconcile(
      selected.length > 8
        ? []
        : selected.flatMap((source) => {
            const access = options.sources.eligibility(source);
            return access
              ? [
                  {
                    source,
                    identity: access.identity,
                    scopeEpoch: access.scopeEpoch,
                  },
                ]
              : [];
          }),
      Date.now(),
    );
    audio.reconcile(config, selected);
    const compute = pool?.getStatus();
    if (computeId !== compute?.processId || compute?.status !== "ready") {
      for (const key of desired.keys())
        retire(key, "Compute unavailable or replaced");
      computeId = compute?.processId;
    }
    if (selected.length > 8) {
      status = "unavailable";
      error = "Perception supports at most 8 camera channels";
      for (const key of desired.keys()) retire(key, error);
      retryAfter.clear();
      store.retain(new Set());
      changed();
      return;
    }
    const selectedKeys = new Set(selected.map(sourceKey));
    for (const key of retryAfter.keys())
      if (!selectedKeys.has(key)) retryAfter.delete(key);
    for (const key of desired.keys())
      if (!selectedKeys.has(key))
        retire(key, "Camera removed from current household");
    store.retain(selectedKeys);
    for (const source of selected) store.expect(source);
    if (compute && !initializing && !configurationError) {
      status = !selected.length
        ? "disabled"
        : compute.status === "ready"
          ? "running"
          : compute.status === "recovering"
            ? "recovering"
            : "unavailable";
      error =
        compute.status === "ready"
          ? undefined
          : (compute.lastError ?? `Compute ${compute.status}`);
    }
    for (const source of selected) {
      const key = sourceKey(source);
      const access = options.sources.eligibility(source);
      const current = desired.get(key);
      if (current && current.identity !== access?.identity)
        retire(key, "Camera access retired");
      if (
        !access ||
        compute?.status !== "ready" ||
        desired.has(key) ||
        performance.now() < (retryAfter.get(key) ?? 0) ||
        cleanup.size
      )
        continue;
      const run = {
        ...source,
        scopeEpoch: access.scopeEpoch,
        runId: crypto.randomUUID(),
      };
      const controller = new AbortController();
      options.appearance?.start({
        run,
        householdVersion: access.householdVersion,
        sampleFps: config.sampleFps,
        maxFrameAgeMs: config.maxFrameAgeMs,
        evidenceTtlMs: config.identity?.evidenceTtlMs ?? 30_000,
        recentTtlMs: identityLimits.recentTtlMs,
        modelVersion: reidSha256,
        processingVersion: reidProcessingVersion,
      });
      store.grant(run);
      windows.bindVideo(run);
      const entry = {
        runId: run.runId,
        identity: access.identity,
        controller,
        pending: Promise.resolve(),
        authorizedAt: access.householdVersion,
      };
      desired.set(key, entry);
      entry.pending = (async () => {
        try {
          const mediaAccess = await prepareSourceLease(
            options.sources,
            source,
            controller.signal,
            () => {
              if (desired.get(key) === entry)
                retire(key, "Media source retired");
            },
          );
          if (desired.get(key) !== entry || controller.signal.aborted) return;
          await pool!.startVideo({
            run,
            access: mediaAccess,
            config,
            executable: options.executable,
          });
        } catch (cause) {
          if (desired.get(key) !== entry) return;
          retryAfter.set(key, performance.now() + 5000);
          retire(key, errorDetails(cause).message);
        }
      })();
    }
    changed();
  }
  const unsubscribeSources = options.sources.subscribe((version) => {
    householdVersion = version;
    reconcile();
  });
  const timer = setInterval(reconcile, 500);
  async function ensurePool() {
    if (stopped) throw new DetectionPoolError("closed", "Perception stopped");
    if (!configRead) await initialize();
    if (configurationError) throw configurationError;
    if (stopped) throw new DetectionPoolError("closed", "Perception stopped");
    if (pool) {
      await pool.retry();
      return pool;
    }
    creatingPool ??= (async () => {
      const created = await createDetectionPool(
        {
          cpuRatio: config.cpuRatio,
          workerLimit: (resources ??= planPerceptionResources(config))
            .videoWorkers,
        },
        shutdown.signal,
      );
      pool = created;
      created.subscribeStatus(reconcile);
      created.subscribeVideo((event) =>
        publishTogether(() => {
          if (event.event === "identity" || event.event === "identity_frame") {
            const value =
              event.event === "identity" ? event.observation : event.identity;
            if (
              JSON.stringify(value.referenceVersions) !==
              referenceVersion(referenceSnapshot)
            )
              return;
          }
          if (event.event === "tracking") {
            const access = options.sources.eligibility(event.run);
            const entry = desired.get(sourceKey(event.run));
            if (
              !access ||
              access.scopeEpoch !== event.run.scopeEpoch ||
              entry?.runId !== event.run.runId ||
              entry.identity !== access.identity
            )
              return;
            // Window history admits original-frame results on its own deadline,
            // independently of live tracking and appearance freshness.
            windows.video(
              {
                event: "tracking",
                run: event.run,
                observation: event.observation,
              },
              Date.now(),
            );
            const accepted = store.receive(event);
            if (accepted) {
              options.appearance?.tracking(
                { ...event.observation, ageMs: accepted.ageMs },
                accepted.acceptedAt,
              );
            }
            if (accepted && event.appearanceEvidence?.length) {
              try {
                options.appearance?.acceptAppearance({
                  evidence: event.appearanceEvidence.map((evidence) => ({
                    ...evidence,
                    ageMs: accepted.ageMs,
                  })),
                  householdVersion: access.householdVersion,
                  acceptedAt: accepted.acceptedAt,
                  remainingMs: config.maxFrameAgeMs - accepted.ageMs,
                });
              } catch (cause) {
                console.error("Appearance evidence delivery failed", cause);
              }
            }
            return;
          }
          windows.video(event, Date.now());
          const accepted = store.receive(event);
          const access = options.sources.eligibility(event.run);
          const entry = desired.get(sourceKey(event.run));
          const authorized =
            access &&
            access.scopeEpoch === event.run.scopeEpoch &&
            entry?.runId === event.run.runId &&
            entry.identity === access.identity;
          if (event.event === "media" && authorized)
            options.appearance?.media(event.run, event.media.generation);
          if (event.event === "identity" && accepted && authorized) {
            options.appearance?.identity(
              { ...event.observation, ageMs: accepted.ageMs },
              accepted.acceptedAt,
              Date.now(),
            );
          }
          if (event.event === "health" && event.status === "failed") {
            const key = sourceKey(event.run);
            if (desired.get(key)?.runId === event.run.runId) {
              retryAfter.set(key, performance.now() + 5000);
              retire(key, event.error ?? "Video unavailable");
            }
          }
        }),
      );
      reconcile();
      return created;
    })().finally(() => {
      creatingPool = undefined;
    });
    return await creatingPool;
  }
  function initialize() {
    initializing ??= (async () => {
      try {
        if (pool) await ensurePool();
        if (configurationError) throw configurationError;
        if (!configRead) {
          configRead = true;
          try {
            config = await readPerceptionConfig(options.configPath);
          } catch (cause) {
            configurationError = cause;
            throw cause;
          }
          unsubscribeStore();
          store.close();
          store = createObservationStore(config.maxFrameAgeMs);
          unsubscribeStore = store.subscribe(changed);
        }
        if (!identityConfigured) {
          await options.identityReferences?.configure(
            config.identity
              ? identityProcessingVersions(config.identity.minimumSharpness)
              : null,
          );
          referenceSnapshot = options.identityReferences?.snapshot() ?? null;
          identityConfigured = true;
        }
        resources ??= planPerceptionResources(config);
        options.speechInbox?.configure(config.dialogue);
        audio.start();
        const videoEnabled =
          config.sources === "household" || config.sources.length > 0;
        if (videoEnabled && !pool) await ensurePool();
        status = videoEnabled ? "running" : "disabled";
        error = undefined;
        reconcile();
      } catch (cause) {
        status = "unavailable";
        error = errorDetails(cause).message;
      } finally {
        changed();
      }
    })().finally(() => {
      initializing = undefined;
    });
    return initializing;
  }
  function updateAssociations() {
    associations.update(
      store.snapshot().filter((source) => {
        if (!source.run) return false;
        const entry = desired.get(sourceKey(source.source));
        const access = options.sources.eligibility(source.run);
        return (
          entry?.runId === source.run.runId &&
          access?.scopeEpoch === source.run.scopeEpoch &&
          access.identity === entry.identity
        );
      }),
      config.identity?.evidenceTtlMs,
      Date.now(),
    );
  }
  function currentSources() {
    return store.snapshot().map((source) => ({
      ...source,
      associations:
        source.trackingValidity === "valid"
          ? associations
              .source(source.run?.runId, Date.now())
              .filter(
                (association) =>
                  association.basis === "appearance" ||
                  association.basis === "species" ||
                  source.identityValidity === "valid",
              )
          : [],
      authorizedAt: source.run
        ? (desired.get(sourceKey(source.source))?.authorizedAt ?? null)
        : null,
    }));
  }
  return {
    start: initialize,
    windows: (selection: Parameters<typeof windows.snapshot>[1]) => {
      const snapshot = windows.snapshot(Date.now(), selection);
      return {
        ...snapshot,
        windows: snapshot.windows.map((entry) => ({
          ...entry,
          sampledMedia: media.sampledMedia(entry.id),
        })),
        media: media.snapshot(),
      };
    },
    window: (id: string) => {
      const entry = windows.describe(id, Date.now());
      return !entry || entry.inputState === "revoked"
        ? undefined
        : { ...entry, sampledMedia: media.sampledMedia(id) };
    },
    media,
    async detectImage(
      input: Parameters<
        Awaited<ReturnType<typeof createDetectionPool>>["detectImage"]
      >[0],
      signal: AbortSignal,
    ) {
      await initializing;
      signal.throwIfAborted();
      const compute = await ensurePool();
      signal.throwIfAborted();
      // Cancellation stops HTTP waiting, not an admitted native computation.
      return await compute.detectImage(input);
    },
    async enrollment(command: z.infer<typeof enrollmentCommandSchema>) {
      await initializing;
      const compute = await ensurePool();
      return compute.enrollment(command);
    },
    appearance: options.appearance,
    identityConfig: () => config.identity,
    petCandidates: (
      className: Parameters<
        ReturnType<typeof createIdentityMatching>["petCandidates"]
      >[0],
    ) => options.identityReferences?.petCandidates(className) ?? null,
    referenceVersions: () =>
      referenceSnapshot
        ? identityReferenceVersionsSchema.parse(referenceSnapshot)
        : null,
    async identityModelStatus(
      className: Extract<
        z.infer<typeof enrollmentCommandSchema>,
        { kind: "identity_status" }
      >["className"],
    ) {
      if (
        stopped ||
        configurationError ||
        (pool && pool.getStatus().status !== "ready")
      )
        return {
          status: "unavailable" as const,
          reason: "身份计算进程不可用，请检查后端配置或等待恢复",
        };
      if (!pool) return { status: "not_checked" as const, reason: null };
      const result = await pool.enrollment({
        kind: "identity_status",
        className,
      });
      if (result.kind !== "identity_status")
        throw new Error("Unexpected identity status result");
      return result;
    },
    async retry() {
      if (stopped) throw new Error("Perception stopped");
      audio.retry();
      await initialize();
      if (pool?.getStatus().status === "ready") await pool.retryTracking();
    },
    snapshot() {
      const audioSnapshot = audio.snapshot();
      return {
        sequence,
        instanceId,
        householdVersion,
        status,
        error,
        config,
        resources: resources ?? null,
        compute: pool?.getStatus() ?? null,
        model: pool?.metadata ?? null,
        audio: audioSnapshot,
        sources: currentSources().map((source) => ({
          ...source,
          audioTrackRunId:
            audioSnapshot.tracks.find(
              (track) =>
                track.run.deviceId === source.source.deviceId &&
                track.channels.includes(source.source.channel),
            )?.run.trackRunId ?? null,
        })),
        rejectedRetiredResults: store.rejectedRetiredResults,
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closing) return closing;
      stopped = true;
      unsubscribeWindows();
      unsubscribeReferences?.();
      shutdown.abort();
      clearInterval(timer);
      unsubscribeSources();
      for (const key of desired.keys()) retire(key, "Perception stopped");
      closing = (async () => {
        const deadline = performance.now() + 10_000;
        try {
          await Promise.allSettled([initializing, creatingPool]);
          // The pool closes the whole video runtime, including sources still
          // preparing when their individual stop command was superseded.
          await Promise.all([
            pool?.close(),
            audio.close(),
            media.close(),
            pTimeout(Promise.all(cleanup), {
              milliseconds: Math.max(1, deadline - performance.now()),
            }),
          ]);
          status = "closed";
        } catch (cause) {
          status = "unavailable";
          error = errorDetails(cause).message;
          throw cause;
        } finally {
          unsubscribeAppearance?.();
          unsubscribeStore();
          store.close();
          windows.close();
          listeners.clear();
        }
      })();
      return closing;
    },
  };
}
