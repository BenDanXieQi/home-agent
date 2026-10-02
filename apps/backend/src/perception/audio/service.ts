import type { createSpeechInbox } from "../../conversation/speech-inbox";
import { isDeepStrictEqual } from "node:util";
import { speechLimits } from "../speech/limits";
import { prepareSourceLease } from "../source-lease";
import type { PerceptionSources } from "../sources";
import type { perceptionConfigSchema, sourceSelectionSchema } from "../config";
import type { z } from "zod";
import type { perceptionSnapshotSchema } from "@home-agent/api/contracts";
import { createAudioProcess } from "./process";
import { initialAudioTrack } from "./protocol";

export function createAudioService(options: {
  sources: PerceptionSources;
  executable: string;
  changed: () => void;
  media?: Parameters<typeof createAudioProcess>[0]["track"];
  speechInbox?: Pick<
    ReturnType<typeof createSpeechInbox>,
    "authorize" | "revoke" | "accept"
  >;
}) {
  const tracks = new Map<string, ReturnType<typeof startTrack>>();
  const cleanup = new Set<Promise<void>>();
  const retryAfter = new Map<string, number>();
  let process: ReturnType<typeof createAudioProcess> | undefined;
  let speechConfiguration:
    | z.infer<typeof perceptionConfigSchema>["speech"]
    | undefined;
  let stopped = false,
    started = false,
    failures = 0;
  let error: string | undefined;
  let nextProcessAt = 0;
  let status: z.infer<typeof perceptionSnapshotSchema>["audio"]["status"] =
    "disabled";
  let closing: Promise<void> | undefined;
  let nextCleanupAt = 0;
  let restartRequested = false;
  let notificationTimer: ReturnType<typeof setTimeout> | undefined;
  function notify() {
    if (stopped || notificationTimer) return;
    notificationTimer = setTimeout(() => {
      notificationTimer = undefined;
      options.changed();
    }, 100);
  }
  function trackCleanup(operation: Promise<unknown>) {
    const task = operation
      .then(
        () => {},
        (cause: unknown) => {
          error = String(cause).slice(0, 4096);
        },
      )
      .finally(() => {
        cleanup.delete(task);
        notify();
      });
    cleanup.add(task);
  }
  function currentTrack(run: ReturnType<typeof initialAudioTrack>["run"]) {
    const entry = tracks.get(run.deviceId);
    if (
      entry &&
      entry.view.run.trackRunId === run.trackRunId &&
      entry.view.run.scopeEpoch === run.scopeEpoch &&
      !entry.controller.signal.aborted
    )
      return entry;
    return undefined;
  }
  function retire(key: string) {
    const entry = tracks.get(key);
    if (!entry) return;
    options.media?.({
      ...entry.view,
      status: "unavailable",
      validity: "unavailable",
      vadStatus: "unavailable",
    });
    tracks.delete(key);
    options.speechInbox?.revoke(entry.view.run.trackRunId);
    entry.controller.abort();
    const owned = process;
    trackCleanup(
      entry.pending.then(() => owned?.stop(entry.view.run.trackRunId)),
    );
  }
  function reconcile(
    config: z.infer<typeof perceptionConfigSchema>,
    selected: z.infer<typeof sourceSelectionSchema>[],
  ) {
    if (stopped || !started) return;
    if (process && !isDeepStrictEqual(speechConfiguration, config.speech))
      restartRequested = true;
    if (selected.length > 8) {
      for (const key of tracks.keys()) retire(key);
      status = "unavailable";
      error = "Audio supports at most 8 camera channels";
      return;
    }
    const grouped = new Map<string, z.infer<typeof sourceSelectionSchema>[]>();
    for (const source of selected) {
      if (!options.sources.eligibility(source)) continue;
      const sources = grouped.get(source.deviceId) ?? [];
      sources.push(source);
      grouped.set(source.deviceId, sources);
    }
    for (const key of retryAfter.keys())
      if (!grouped.has(key)) retryAfter.delete(key);
    for (const [key, entry] of tracks) {
      const group = grouped.get(key);
      if (!group) {
        retire(key);
        continue;
      }
      const source = group.find(
        (candidate) => candidate.channel === entry.channel,
      );
      if (
        !source ||
        options.sources.eligibility(source)?.identity !== entry.identity
      ) {
        retire(key);
        continue;
      }
      entry.view.channels = group.map((candidate) => candidate.channel);
      if (
        entry.view.validity === "valid" &&
        performance.now() >= entry.expiresAt
      ) {
        entry.view.validity = "expired";
        options.media?.(entry.view);
        notify();
      }
      if (
        (entry.view.status === "failed" || entry.view.status === "no_track") &&
        performance.now() >= (retryAfter.get(key) ?? 0)
      )
        retire(key);
    }
    if (!grouped.size) {
      status = selected.length ? "unavailable" : "disabled";
      error = selected.length ? "Audio camera access unavailable" : undefined;
      return;
    }
    if (process && (process.status.error || restartRequested)) {
      for (const key of tracks.keys()) retire(key);
      const owned = process;
      if (!cleanup.size && performance.now() >= nextCleanupAt) {
        trackCleanup(
          owned
            .close()
            .then(() => {
              if (process === owned) process = undefined;
              restartRequested = false;
              nextCleanupAt = 0;
            })
            .catch((cause) => {
              nextCleanupAt = performance.now() + 5000;
              status = "unavailable";
              throw cause;
            }),
        );
      }
      return;
    }
    if (cleanup.size || performance.now() < nextProcessAt || failures >= 3)
      return;
    if (!process) {
      status = "starting";
      try {
        speechConfiguration = { ...config.speech };
        process = createAudioProcess({
          speech(observation) {
            if (!currentTrack(observation.run)) return false;
            return options.speechInbox?.accept(observation) ?? false;
          },
          track(view, pcm) {
            const entry = currentTrack(view.run);
            if (!entry) return;
            if (view.sequence < entry.view.sequence) return;
            entry.view = { ...view, channels: entry.view.channels };
            const age =
              view.observedAt === null ? 0 : Date.now() - view.observedAt;
            entry.expiresAt =
              performance.now() + config.maxFrameAgeMs - Math.max(0, age);
            if (age < -config.maxFrameAgeMs)
              entry.view.validity = "unavailable";
            if (view.speech?.validity === "unavailable")
              options.speechInbox?.revoke(view.run.trackRunId);
            if (view.status === "failed" || view.status === "no_track") {
              options.speechInbox?.revoke(view.run.trackRunId);
              retryAfter.set(view.run.deviceId, performance.now() + 5000);
            }
            options.media?.(entry.view, pcm);
            notify();
          },
          failure(reason) {
            failures++;
            nextProcessAt = performance.now() + 5000;
            status = "unavailable";
            error = reason;
            for (const entry of tracks.values()) {
              options.speechInbox?.revoke(entry.view.run.trackRunId);
              entry.view = {
                ...entry.view,
                status: "unavailable",
                validity: "unavailable",
                vadStatus: "unavailable",
                error: reason,
                energy: [],
                vad: [],
                speech: entry.view.speech && {
                  ...entry.view.speech,
                  status: "unavailable",
                  validity: "unavailable",
                },
              };
              options.media?.(entry.view);
            }
            notify();
          },
        });
      } catch (cause) {
        failures++;
        nextProcessAt = performance.now() + 5000;
        status = "unavailable";
        error = String(cause).slice(0, 4096);
        return;
      }
    }
    if (process.status.ready) {
      status = "running";
      error = undefined;
    }
    for (const [deviceId, group] of grouped) {
      if (
        tracks.has(deviceId) ||
        performance.now() < (retryAfter.get(deviceId) ?? 0)
      )
        continue;
      for (const source of group) {
        const access = options.sources.eligibility(source);
        if (access) {
          startTrack(source, group, access, config, process);
          break;
        }
      }
    }
  }
  function startTrack(
    source: z.infer<typeof sourceSelectionSchema>,
    group: z.infer<typeof sourceSelectionSchema>[],
    access: NonNullable<ReturnType<typeof options.sources.eligibility>>,
    config: z.infer<typeof perceptionConfigSchema>,
    owned: ReturnType<typeof createAudioProcess>,
  ) {
    const deviceId = source.deviceId;
    const run = {
      deviceId,
      scopeEpoch: access.scopeEpoch,
      trackRunId: crypto.randomUUID(),
    };
    const entry = {
      identity: access.identity,
      channel: source.channel,
      controller: new AbortController(),
      view: initialAudioTrack({
        run,
        channels: group.map((candidate) => candidate.channel),
      }),
      pending: Promise.resolve(),
      expiresAt: 0,
    };
    tracks.set(deviceId, entry);
    options.speechInbox?.authorize(run);
    entry.pending = (async () => {
      try {
        const mediaAccess = await prepareSourceLease(
          options.sources,
          source,
          entry.controller.signal,
          () => {
            if (tracks.get(deviceId) === entry) retire(deviceId);
          },
        );
        if (tracks.get(deviceId) !== entry || entry.controller.signal.aborted)
          return;
        await owned.start(
          {
            run,
            channels: entry.view.channels,
            config,
            access: mediaAccess,
            executable: options.executable,
          },
          entry.controller.signal,
        );
      } catch (cause) {
        if (tracks.get(deviceId) !== entry || entry.controller.signal.aborted)
          return;
        entry.view = {
          ...entry.view,
          status: "failed",
          validity: "unavailable",
          vadStatus: "unavailable",
          error: String(cause).slice(0, 4096),
        };
        retryAfter.set(deviceId, performance.now() + 5000);
        options.media?.(entry.view);
        notify();
      }
    })();
    return entry;
  }

  return {
    start() {
      started = true;
    },
    reconcile,
    retry() {
      if (
        process &&
        (!process.status.model ||
          [...tracks.values()].some((entry) => entry.view.vadError))
      )
        restartRequested = true;
      for (const [key, entry] of tracks) {
        if (entry.view.speech?.validity === "unavailable") retire(key);
      }
      process?.retrySpeech();
      failures = 0;
      nextProcessAt = 0;
      nextCleanupAt = 0;
      retryAfter.clear();
    },
    snapshot() {
      const state = process?.status;
      const speech = state?.speech;
      const inactiveSpeech =
        status === "closed" ? "closed" : state?.error ? "unavailable" : null;
      return {
        status,
        error,
        processId: state?.processId,
        model: state?.model ?? null,
        speech: speech && {
          ...speech,
          ...(inactiveSpeech
            ? {
                status: inactiveSpeech,
                processId: undefined,
                processRssBytes: null,
                queueDepth: 0,
                queueBytes: 0,
                inFlight: false,
                error: state.error,
              }
            : {}),
        },
        tracks: [...tracks.values()].map(({ view, expiresAt }) => ({
          ...view,
          speech: view.speech && {
            ...view.speech,
            validity:
              view.speech.validity === "valid" &&
              view.speech.latest &&
              Date.now() - view.speech.latest.observedEndAt >=
                speechLimits.resultAgeMs
                ? ("expired" as const)
                : view.speech.validity,
          },
          validity:
            view.validity === "valid" && performance.now() >= expiresAt
              ? ("expired" as const)
              : view.validity,
        })),
      };
    },
    close() {
      closing ??= (async () => {
        stopped = true;
        clearTimeout(notificationTimer);
        for (const key of tracks.keys()) retire(key);
        await Promise.all([process?.close(), ...cleanup]);
        status = "closed";
      })();
      return closing;
    },
  };
}
