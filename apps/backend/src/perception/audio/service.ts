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
}) {
  const tracks = new Map<
    string,
    {
      identity: string;
      channel: z.infer<typeof sourceSelectionSchema>["channel"];
      controller: AbortController;
      view: ReturnType<typeof initialAudioTrack>;
      pending: Promise<void>;
      expiresAt: number;
    }
  >();
  const cleanup = new Set<Promise<void>>();
  const retryAfter = new Map<string, number>();
  let process: ReturnType<typeof createAudioProcess> | undefined;
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
    entry.controller.abort();
    const owned = process;
    const task = entry.pending
      .then(async () => {
        await owned?.stop(entry.view.run.trackRunId);
      })
      .catch((cause) => {
        error = String(cause).slice(0, 4096);
        notify();
      });
    cleanup.add(task);
    task.then(
      () => {
        cleanup.delete(task);
        notify();
      },
      (cause: unknown) => {
        error = String(cause).slice(0, 4096);
        notify();
      },
    );
  }
  function reconcile(
    config: z.infer<typeof perceptionConfigSchema>,
    selected: z.infer<typeof sourceSelectionSchema>[],
  ) {
    if (stopped || !started) return;
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
      const source = group?.find(
        (candidate) => candidate.channel === entry.channel,
      );
      if (
        !source ||
        options.sources.eligibility(source)?.identity !== entry.identity
      ) {
        retire(key);
        continue;
      }
      entry.view.channels = group!.map((candidate) => candidate.channel);
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
        const task = owned
          .close()
          .then(() => {
            if (process === owned) process = undefined;
            restartRequested = false;
            nextCleanupAt = 0;
          })
          .catch((cause) => {
            nextCleanupAt = performance.now() + 5000;
            status = "unavailable";
            error = String(cause).slice(0, 4096);
          });
        cleanup.add(task);
        task.then(
          () => {
            cleanup.delete(task);
            notify();
          },
          (cause: unknown) => {
            error = String(cause).slice(0, 4096);
            notify();
          },
        );
      }
      return;
    }
    if (cleanup.size || performance.now() < nextProcessAt || failures >= 3)
      return;
    if (!process) {
      status = "starting";
      try {
        process = createAudioProcess({
          track(view, pcm) {
            const entry = tracks.get(view.run.deviceId);
            if (
              !entry ||
              entry.view.run.trackRunId !== view.run.trackRunId ||
              entry.view.run.scopeEpoch !== view.run.scopeEpoch
            )
              return;
            if (view.sequence < entry.view.sequence) return;
            entry.view = { ...view, channels: entry.view.channels };
            const age =
              view.observedAt === null ? 0 : Date.now() - view.observedAt;
            entry.expiresAt =
              performance.now() + config.maxFrameAgeMs - Math.max(0, age);
            if (age < -config.maxFrameAgeMs)
              entry.view.validity = "unavailable";
            if (view.status === "failed" || view.status === "no_track")
              retryAfter.set(view.run.deviceId, performance.now() + 5000);
            options.media?.(entry.view, pcm);
            notify();
          },
          failure(reason) {
            failures++;
            nextProcessAt = performance.now() + 5000;
            status = "unavailable";
            error = reason;
            for (const entry of tracks.values()) {
              entry.view = {
                ...entry.view,
                status: "unavailable",
                validity: "unavailable",
                vadStatus: "unavailable",
                error: reason,
                energy: [],
                vad: [],
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
      const source = group.find((candidate) =>
        options.sources.eligibility(candidate),
      );
      if (!source) continue;
      const access = options.sources.eligibility(source)!;
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
      const owned = process;
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
    }
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
      failures = 0;
      nextProcessAt = 0;
      nextCleanupAt = 0;
      retryAfter.clear();
    },
    snapshot() {
      return {
        status,
        error,
        processId: process?.status.processId,
        model: process?.status.model ?? null,
        tracks: [...tracks.values()].map((entry) => ({
          ...entry.view,
          validity:
            entry.view.validity === "valid" &&
            performance.now() >= entry.expiresAt
              ? ("expired" as const)
              : entry.view.validity,
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
