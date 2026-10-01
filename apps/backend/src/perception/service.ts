import { prepareSourceLease } from "./source-lease";
import { createAudioService } from "./audio/service";
import { errorDetails } from "./compute/protocol";
import pTimeout from "p-timeout";
import type { PerceptionSources } from "./sources";
import { readPerceptionConfig } from "./config-file";
import { perceptionConfigSchema, sourceKey } from "./config";
import { createDetectionPool } from "./compute/pool";
import { createObservationStore } from "./observation-store";

// Capture belongs to the backend; browser viewing and freezing do not own its lifetime.
export function createPerceptionService(options: {
  configPath: string;
  executable: string;
  sources: PerceptionSources;
}) {
  const instanceId = crypto.randomUUID();
  let householdVersion:
    | Parameters<Parameters<typeof options.sources.subscribe>[0]>[0]
    | null = null;
  let sequence = 0;
  let config = perceptionConfigSchema.parse({});
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
  let closing: Promise<void> | undefined;
  let configRead = false;
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
  const changed = () => {
    sequence++;
    for (const listener of listeners) listener();
  };
  const audio = createAudioService({
    sources: options.sources,
    executable: options.executable,
    changed,
  });
  let unsubscribeStore = store.subscribe(changed);
  function retire(key: string, reason: string) {
    const entry = desired.get(key);
    if (!entry) return;
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
  }
  function reconcile() {
    if (stopped) return;
    const selected =
      config.sources === "household" ? options.sources.list() : config.sources;
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
    if (compute && !initializing) {
      status =
        compute.status === "ready"
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
      store.grant(run);
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
  function initialize() {
    initializing ??= (async () => {
      try {
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
        audio.start();
        if (config.sources !== "household" && !config.sources.length) {
          status = "disabled";
          return;
        }
        if (!pool) {
          shutdown.signal.throwIfAborted();
          pool = await createDetectionPool(
            { cpuRatio: config.cpuRatio },
            shutdown.signal,
          );
          pool.subscribeStatus(reconcile);
          pool.subscribeVideo((event) => {
            store.receive(event);
            if (event.event === "health" && event.status === "failed") {
              const key = sourceKey(event.run);
              if (desired.get(key)?.runId === event.run.runId) {
                retryAfter.set(key, performance.now() + 5000);
                retire(key, event.error ?? "Video unavailable");
              }
            }
          });
        } else await pool.retry();
        status = "running";
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
  return {
    start: initialize,
    retry() {
      if (stopped) return Promise.reject(new Error("Perception stopped"));
      audio.retry();
      return initialize();
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
        compute: pool?.getStatus() ?? null,
        model: pool?.metadata ?? null,
        audio: audioSnapshot,
        sources: store.snapshot().map((source) => ({
          audioTrackRunId:
            audioSnapshot.tracks.find(
              (track) =>
                track.run.deviceId === source.source.deviceId &&
                track.channels.includes(source.source.channel),
            )?.run.trackRunId ?? null,
          ...source,
          authorizedAt: source.run
            ? (desired.get(sourceKey(source.source))?.authorizedAt ?? null)
            : null,
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
      shutdown.abort();
      clearInterval(timer);
      unsubscribeSources();
      for (const key of desired.keys()) retire(key, "Perception stopped");
      closing = (async () => {
        const deadline = performance.now() + 10_000;
        try {
          await initializing;
          // The pool closes the whole video runtime, including sources still
          // preparing when their individual stop command was superseded.
          await Promise.all([
            pool?.close(),
            audio.close(),
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
          unsubscribeStore();
          store.close();
          listeners.clear();
        }
      })();
      return closing;
    },
  };
}
