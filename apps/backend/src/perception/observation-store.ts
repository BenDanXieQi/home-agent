import type { z } from "zod";
import {
  acceptsObservation,
  isCurrentRun,
  type observationSchema,
  type runSchema,
} from "./observations";
import type { videoEventSchema } from "./video/events";
import { sourceKey, type sourceSelectionSchema } from "./config";
import { createVideoMetrics } from "./video/metrics";

function initial(source: z.infer<typeof sourceSelectionSchema>) {
  return {
    source,
    run: null as z.infer<typeof runSchema> | null,
    granted: false,
    status: "waiting_for_access",
    error: undefined as string | undefined,
    observation: null as z.infer<typeof observationSchema> | null,
    validity: "no_data",
    sequence: 0,
    expiresAt: 0,
    lastPublishedAt: 0,
    grantedAt: performance.now(),
    firstPublicationMs: 0,
    published: 0,
    rejected: 0,
    expiredResults: 0,
    intervalMaxMs: 0,
    metrics: createVideoMetrics().snapshot(),
  };
}
export function createObservationStore(maxAgeMs: number) {
  const sources = new Map<string, ReturnType<typeof initial>>();
  const listeners = new Set<() => void>();
  let rejectedRetiredResults = 0;
  function changed() {
    for (const listener of listeners) listener();
  }
  const timer = setInterval(() => {
    let expired = false;
    for (const entry of sources.values())
      if (entry.validity === "valid" && performance.now() >= entry.expiresAt) {
        entry.validity = "expired";
        expired = true;
      }
    if (expired) changed();
  }, 50);
  return {
    get rejectedRetiredResults() {
      return rejectedRetiredResults;
    },
    expect(source: z.infer<typeof sourceSelectionSchema>) {
      if (sources.has(sourceKey(source))) return;
      sources.set(sourceKey(source), initial(source));
      changed();
    },
    retain(keys: ReadonlySet<string>) {
      let removed = false;
      for (const key of sources.keys())
        if (!keys.has(key)) {
          sources.delete(key);
          removed = true;
        }
      if (removed) changed();
    },
    grant(run: z.infer<typeof runSchema>) {
      sources.set(sourceKey(run), {
        ...initial({ deviceId: run.deviceId, channel: run.channel }),
        run,
        granted: true,
        status: "starting",
      });
      changed();
    },
    revoke(key: string, reason: string) {
      const entry = sources.get(key);
      if (!entry) return;
      entry.status = "unavailable";
      entry.validity = "unavailable";
      entry.error = reason;
      entry.granted = false;
      entry.observation = null;
      changed();
    },
    receive(event: z.infer<typeof videoEventSchema>) {
      const entry = sources.get(sourceKey(event.run));
      if (
        !entry ||
        !entry.granted ||
        !entry.run ||
        !isCurrentRun(entry.run, event.run)
      ) {
        if (event.event === "settled") {
          rejectedRetiredResults++;
          changed();
        }
        return;
      }
      entry.metrics = event.metrics;
      if (event.event === "health") {
        entry.status = event.status;
        entry.error = event.error;
        entry.metrics = event.metrics;
      }
      if (event.event === "settled" && event.observation) {
        const observation = event.observation;
        // Both processes use the host wall clock only to account for IPC residence.
        // Reject a clock rollback; expiry thereafter uses this process's monotonic clock.
        const elapsed = Date.now() - observation.receivedAt;
        const age = Math.max(observation.ageMs, elapsed);
        if (
          elapsed < 0 ||
          !acceptsObservation(
            entry.run,
            entry.sequence,
            observation,
            age,
            maxAgeMs,
          )
        ) {
          if (age >= maxAgeMs) entry.expiredResults++;
          else entry.rejected++;
        } else {
          const now = performance.now();
          if (entry.lastPublishedAt)
            entry.intervalMaxMs = Math.max(
              entry.intervalMaxMs,
              now - entry.lastPublishedAt,
            );
          if (!entry.lastPublishedAt)
            entry.firstPublicationMs = now - entry.grantedAt;
          entry.lastPublishedAt = now;
          entry.published++;
          entry.sequence = observation.sequence;
          entry.observation = { ...observation, ageMs: age };
          entry.expiresAt = now + maxAgeMs - age;
          entry.validity = "valid";
        }
      }
      changed();
    },
    snapshot() {
      const now = performance.now();
      return [...sources.values()].map((entry) => ({
        source: entry.source,
        run: entry.run,
        status: entry.status,
        error: entry.error,
        validity:
          entry.validity === "valid" && now >= entry.expiresAt
            ? "expired"
            : entry.validity,
        observation: entry.observation,
        metrics: {
          ...entry.metrics,
          published: entry.published,
          firstPublicationMs: entry.firstPublicationMs,
          waitingForFirstMs: entry.lastPublishedAt ? 0 : now - entry.grantedAt,
          rejected: entry.rejected,
          expiredResults: entry.expiredResults,
          intervalMaxMs: Math.max(
            entry.intervalMaxMs,
            entry.lastPublishedAt ? now - entry.lastPublishedAt : 0,
          ),
        },
      }));
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      clearInterval(timer);
      listeners.clear();
      sources.clear();
    },
  };
}
