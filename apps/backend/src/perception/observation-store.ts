import type {
  sourceMediaSchema,
  identityObservationSchema,
  trackingObservationSchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import {
  acceptsObservation,
  isCurrentRun,
  type observationSchema,
  type runSchema,
} from "./observations";
import { validAppearanceEvent, type videoEventSchema } from "./video/events";
import { sourceKey, type sourceSelectionSchema } from "./config";
import { createVideoMetrics } from "./video/metrics";

function initial(source: z.infer<typeof sourceSelectionSchema>) {
  return {
    source,
    run: null as z.infer<typeof runSchema> | null,
    granted: false,
    media: null as z.infer<typeof sourceMediaSchema> | null,
    status: "waiting_for_access",
    error: undefined as string | undefined,
    observation: null as z.infer<typeof observationSchema> | null,
    validity: "no_data",
    tracking: null as z.infer<typeof trackingObservationSchema> | null,
    trackingValidity: "no_data",
    identity: null as z.infer<typeof identityObservationSchema> | null,
    identityValidity: "no_data",
    identityRevision: 0,
    identityExpiresAt: 0,
    trackingSequence: 0,
    trackingExpiresAt: 0,
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
    for (const entry of sources.values()) {
      if (
        entry.identityValidity === "valid" &&
        performance.now() >= entry.identityExpiresAt
      ) {
        entry.identityValidity = "expired";
        expired = true;
      }
      if (
        entry.trackingValidity === "valid" &&
        performance.now() >= entry.trackingExpiresAt
      ) {
        entry.trackingValidity = "expired";
        expired = true;
      }
      if (entry.validity === "valid" && performance.now() >= entry.expiresAt) {
        entry.validity = "expired";
        expired = true;
      }
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
      entry.media = null;
      entry.observation = null;
      entry.tracking = null;
      entry.identity = null;
      entry.identityValidity = "unavailable";
      entry.trackingValidity = "unavailable";
      changed();
    },
    invalidateIdentity() {
      for (const entry of sources.values()) {
        entry.identity = null;
        entry.identityValidity = "unavailable";
      }
      changed();
    },
    receive(event: z.infer<typeof videoEventSchema>) {
      if (
        event.event === "window_frame" ||
        event.event === "window_gap" ||
        event.event === "identity_frame"
      )
        return null;
      const entry = sources.get(sourceKey(event.run));
      if (
        !entry ||
        !entry.granted ||
        !entry.run ||
        !isCurrentRun(entry.run, event.run)
      ) {
        if (
          event.event === "settled" ||
          event.event === "tracking" ||
          event.event === "identity"
        ) {
          rejectedRetiredResults++;
          changed();
        }
        return null;
      }
      if (event.event === "media") {
        if (entry.media?.generation !== event.media.generation) {
          entry.identity = null;
          entry.identityValidity = "no_data";
        }
        entry.media = event.media;
        changed();
        return null;
      }
      if (
        (event.event === "tracking" ||
          event.event === "settled" ||
          event.event === "identity") &&
        event.observation &&
        event.observation.mediaTime.generation !== entry.media?.generation
      ) {
        entry.rejected++;
        changed();
        return null;
      }
      if (event.event === "identity") {
        const result = event.observation;
        const elapsed = Date.now() - result.receivedAt;
        const age = Math.max(elapsed, result.ageMs);
        if (
          entry.status !== "failed" &&
          isCurrentRun(entry.run, result.run) &&
          result.revision > entry.identityRevision &&
          result.sequence >= (entry.identity?.sequence ?? 0) &&
          elapsed >= 0 &&
          age < maxAgeMs
        ) {
          entry.identity = { ...result, ageMs: age };
          entry.identityRevision = result.revision;
          const acceptedAt = performance.now();
          entry.identityExpiresAt = acceptedAt + maxAgeMs - age;
          entry.identityValidity =
            result.status === "unavailable" ? "unavailable" : "valid";
          changed();
          return { ageMs: age, acceptedAt };
        }
        changed();
        return null;
      }
      if (event.event === "tracking") {
        const result = event.observation;
        const elapsed = Date.now() - result.receivedAt;
        const age = Math.max(elapsed, result.ageMs);
        if (
          validAppearanceEvent(event) &&
          entry.status !== "failed" &&
          isCurrentRun(entry.run, result.run) &&
          result.sequence > entry.trackingSequence &&
          elapsed >= 0 &&
          age < maxAgeMs
        ) {
          const acceptedAt = performance.now();
          entry.tracking = { ...result, ageMs: age };
          entry.trackingSequence = result.sequence;
          entry.trackingExpiresAt = acceptedAt + maxAgeMs - age;
          entry.trackingValidity =
            result.status === "failed" ? "unavailable" : "valid";
          changed();
          return { ageMs: age, acceptedAt };
        }
        changed();
        return null;
      }
      entry.metrics = event.metrics;
      if (event.event === "health") {
        entry.status = event.status;
        if (event.status === "failed") {
          entry.trackingValidity = "unavailable";
          entry.identityValidity = "unavailable";
          entry.identity = null;
        }
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
      return null;
    },
    snapshot() {
      const now = performance.now();
      return [...sources.values()].map((entry) => ({
        source: entry.source,
        media: entry.media,
        run: entry.run,
        status: entry.status,
        error: entry.error,
        validity:
          entry.validity === "valid" && now >= entry.expiresAt
            ? "expired"
            : entry.validity,
        observation: entry.observation,
        tracking: entry.tracking,
        identity: entry.identity,
        identityValidity:
          entry.identityValidity === "valid" && now >= entry.identityExpiresAt
            ? "expired"
            : entry.identityValidity,
        trackingValidity:
          entry.trackingValidity === "valid" && now >= entry.trackingExpiresAt
            ? "expired"
            : entry.trackingValidity,
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
