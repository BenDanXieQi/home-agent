import type { z } from "zod";
import type {
  audioTrackSchema,
  windowSummarySchema,
} from "@home-agent/api/contracts";
import type { pcmSchema } from "../audio/pcm";
import {
  createWindowDraft,
  summarizeWindow,
  truncateWindow,
} from "./aggregate";
import { appendWindowAudio, recordAudioStatus } from "./audio-coverage";
import { sourceKey, type sourceSelectionSchema } from "../config";
import {
  isCurrentRun,
  type runSchema,
  type observationSchema,
} from "../observations";
import type { videoEventSchema } from "../video/events";
import { windowLimits } from "./limits";

function source(run: z.infer<typeof runSchema>, identity: string, now: number) {
  return {
    run,
    videoRun: null as z.infer<typeof runSchema> | null,
    identity,
    startedAt: now,
    drafts: new Map<number, ReturnType<typeof createWindowDraft>>(),
    baseline: null as Parameters<typeof summarizeWindow>[1]["baseline"],
    lastChangeAt: null as number | null,
    audioTrack: null as z.infer<typeof audioTrackSchema> | null,
    observations: new Map<number, z.infer<typeof observationSchema>>(),
    tracking: new Map<
      number,
      Extract<
        z.infer<typeof videoEventSchema>,
        { event: "tracking" }
      >["observation"]
    >(),
    lastClosedAt: -Infinity,
  };
}
function retained(
  summary: z.infer<typeof windowSummarySchema>,
  input: ReturnType<typeof createWindowDraft>,
  identity: string,
) {
  return {
    summary,
    input,
    identity,
    controller: new AbortController(),
    expiresAt:
      performance.now() + Math.max(0, summary.readableUntil - summary.closedAt),
  };
}
type RetainedWindow = ReturnType<typeof retained>;

export function createWindowStore(options: {
  retentionMs: () => number;
  authorized: (run: z.infer<typeof runSchema>, identity: string) => boolean;
}) {
  const sources = new Map<string, ReturnType<typeof source>>();
  const windows = new Map<string, RetainedWindow>();
  const counters = {
    closed: 0,
    candidates: 0,
    skipped: 0,
    evicted: 0,
    expired: 0,
    revoked: 0,
    droppedFrames: 0,
    droppedAudio: 0,
    droppedWindows: 0,
    lateObservations: 0,
  };
  let bytes = 0;
  function release(
    entry: RetainedWindow,
    reason: "expired" | "evicted" | "revoked",
    count = true,
  ) {
    if (entry.summary.inputState !== "available") {
      if (reason === "revoked") entry.summary.inputState = reason;
      return;
    }
    if (count) counters[reason]++;
    entry.summary.inputState = reason;
    entry.controller.abort(new Error(`Window ${reason}`));
    bytes -= entry.input.bytes;
    entry.input.bytes = 0;
    entry.input.frames = [];
    entry.input.audio = [];
  }
  function room(size: number) {
    for (const entry of windows.values()) {
      if (bytes + size <= windowLimits.inputBytes) break;
      release(entry, "evicted");
    }
    return bytes + size <= windowLimits.inputBytes;
  }
  function getDraft(entry: ReturnType<typeof source>, at: number) {
    const start =
      Math.floor(at / windowLimits.durationMs) * windowLimits.durationMs;
    if (at < entry.startedAt || start < entry.lastClosedAt) return undefined;
    let value = entry.drafts.get(start);
    if (!value) {
      if (entry.drafts.size >= windowLimits.readyPerSource) {
        const key = entry.drafts.keys().next().value!;
        const old = entry.drafts.get(key)!;
        bytes -= old.bytes;
        entry.drafts.delete(key);
        counters.droppedWindows++;
      }
      value = createWindowDraft(
        Math.max(start, entry.startedAt),
        start + windowLimits.durationMs,
        start < entry.startedAt,
      );
      if (entry.audioTrack) recordAudioStatus(value, entry.audioTrack);
      entry.drafts.set(start, value);
    }
    return value;
  }
  function finalize(
    entry: ReturnType<typeof source>,
    value: ReturnType<typeof createWindowDraft>,
    now: number,
  ) {
    counters.closed++;
    const resultSummary = summarizeWindow(value, entry);
    entry.baseline = resultSummary.baseline;
    entry.lastChangeAt = resultSummary.lastChangeAt;
    const summary: z.infer<typeof windowSummarySchema> = {
      id: crypto.randomUUID(),
      run: entry.run,
      videoRun: value.videoRun,
      generation: value.frames[0]?.mediaTime.generation ?? null,
      processingVersion: "media-window-1",
      startedAt: value.startedAt,
      endedAt: value.endedAt,
      closedAt: now,
      readableUntil: now + options.retentionMs(),
      summaryUntil: now + windowLimits.summaryMs,
      timeBasis: "host_receive",
      synchronizationAccuracyMs: null,
      incomplete: value.incomplete,
      gaps: [...value.gaps],
      frames: value.frames.map(({ rgb: _rgb, gray: _gray, ...frame }) => frame),
      audio: resultSummary.audio,
      gate: resultSummary.gate,
      crop: resultSummary.crop,
      inputState: "available",
    };
    if (resultSummary.gate.candidate === "audio") {
      const videoBytes = value.frames.reduce(
        (sum, frame) => sum + frame.rgb.byteLength + frame.gray.byteLength,
        0,
      );
      value.frames = [];
      value.bytes -= videoBytes;
      bytes -= videoBytes;
    }
    const result = retained(summary, value, entry.identity);
    windows.set(summary.id, result);
    if (resultSummary.gate.candidate === "none") {
      counters.skipped++;
      release(result, "evicted", false);
    } else counters.candidates++;
    const ready = [...windows.values()].filter(
      (window) =>
        window.summary.run.deviceId === entry.run.deviceId &&
        window.summary.run.channel === entry.run.channel &&
        window.summary.inputState === "available",
    );
    while (ready.length > windowLimits.readyPerSource)
      release(ready.shift()!, "evicted");
    while (windows.size > windowLimits.summaries) {
      const oldest = windows.keys().next().value!;
      release(windows.get(oldest)!, "evicted");
      windows.delete(oldest);
    }
    entry.lastClosedAt = Math.max(entry.lastClosedAt, value.endedAt);
  }
  function tick(now: number) {
    for (const [id, entry] of sources) {
      if (!options.authorized(entry.run, entry.identity)) {
        stop(id, true, now);
        continue;
      }
      // Empty windows are facts about missing input, never an absence judgment.
      getDraft(entry, now);
      const ready = [...entry.drafts.entries()]
        .filter(([, value]) => value.endedAt + windowLimits.graceMs <= now)
        .toSorted(([a], [b]) => a - b);
      for (const [index, [key, value]] of ready.entries()) {
        entry.drafts.delete(key);
        if (index < ready.length - 1) {
          bytes -= value.bytes;
          counters.droppedWindows++;
        } else finalize(entry, value, now);
      }
      for (const [sequence, observation] of entry.observations)
        if (observation.receivedAt < now - 4500)
          entry.observations.delete(sequence);
      for (const [sequence, observation] of entry.tracking)
        if (observation.receivedAt < now - 4500)
          entry.tracking.delete(sequence);
    }
    for (const [id, entry] of windows) maintain(id, entry, now);
  }
  function maintain(id: string, entry: RetainedWindow, now: number) {
    if (!options.authorized(entry.summary.run, entry.identity))
      release(entry, "revoked");
    else if (
      now >= entry.summary.readableUntil ||
      performance.now() >= entry.expiresAt
    )
      release(entry, "expired");
    if (now >= entry.summary.summaryUntil) {
      release(entry, "expired");
      windows.delete(id);
    }
  }

  function lookup(id: string, now: number) {
    const entry = windows.get(id);
    if (entry) maintain(id, entry, now);
    return windows.get(id);
  }

  function finishDrafts(entry: ReturnType<typeof source>, now: number) {
    for (const value of [...entry.drafts.values()].toSorted(
      (a, b) => a.startedAt - b.startedAt,
    )) {
      if (value.startedAt >= now) {
        bytes -= value.bytes;
        continue;
      }
      bytes -= truncateWindow(value, now);
      finalize(entry, value, now);
    }
    entry.drafts.clear();
  }
  function stop(key: string, revoke: boolean, now: number) {
    const entry = sources.get(key);
    if (!entry) return;
    sources.delete(key);
    if (revoke) {
      for (const value of entry.drafts.values()) bytes -= value.bytes;
      for (const window of windows.values())
        if (window.summary.run.runId === entry.run.runId)
          release(window, "revoked");
    } else finishDrafts(entry, now);
  }
  return {
    tick,
    reconcile(
      selected: {
        source: z.infer<typeof sourceSelectionSchema>;
        identity: string;
        scopeEpoch: z.infer<typeof runSchema>["scopeEpoch"];
      }[],
      now: number,
    ) {
      const wanted = new Map(
        selected.map((selection) => [sourceKey(selection.source), selection]),
      );
      for (const [key, entry] of sources) {
        const next = wanted.get(key);
        if (
          !next ||
          next.identity !== entry.identity ||
          next.scopeEpoch !== entry.run.scopeEpoch
        )
          stop(key, !options.authorized(entry.run, entry.identity), now);
      }
      for (const [key, selection] of wanted) {
        if (!sources.has(key))
          sources.set(
            key,
            source(
              {
                ...selection.source,
                scopeEpoch: selection.scopeEpoch,
                runId: crypto.randomUUID(),
              },
              selection.identity,
              now,
            ),
          );
      }
    },
    bindVideo(run: z.infer<typeof runSchema>) {
      const entry = sources.get(sourceKey(run));
      if (!entry || entry.run.scopeEpoch !== run.scopeEpoch) return;
      if (entry.videoRun && isCurrentRun(entry.videoRun, run)) return;
      entry.observations.clear();
      entry.tracking.clear();
      entry.videoRun = run;
    },
    stopVideo(runId: string) {
      for (const entry of sources.values()) {
        if (entry.videoRun?.runId !== runId) continue;
        entry.observations.clear();
        entry.tracking.clear();
        entry.videoRun = null;
      }
    },
    video(event: z.infer<typeof videoEventSchema>, now: number) {
      const entry = sources.get(sourceKey(event.run));
      if (
        !entry ||
        !entry.videoRun ||
        !isCurrentRun(entry.videoRun, event.run) ||
        !options.authorized(entry.run, entry.identity)
      )
        return;
      if (event.event === "window_gap") {
        getDraft(entry, event.at)?.gaps.add(event.reason);
      } else if (event.event === "window_frame") {
        const frame = event.frame;
        if (
          frame.receivedAt > now ||
          now - frame.receivedAt >
            windowLimits.durationMs + windowLimits.graceMs
        ) {
          counters.droppedFrames++;
          return;
        }
        const value = getDraft(entry, frame.receivedAt);
        if (!value) {
          counters.droppedFrames++;
          return;
        }
        // A video restart cannot truncate a healthy audio window. Keep its
        // original video producer and admit the replacement in the next window.
        if (value.videoRun && !isCurrentRun(value.videoRun, event.run)) {
          counters.droppedFrames++;
          value.gaps.add("video_run_changed");
          return;
        }
        if (event.skipped) {
          counters.droppedFrames += event.skipped;
          value.gaps.add("capture_capacity");
        }
        const size = frame.rgb.byteLength + frame.gray.byteLength;
        if (
          value.frames.length >= windowLimits.framesPerWindow ||
          value.bytes + size > windowLimits.windowBytes ||
          !room(size)
        ) {
          counters.droppedFrames++;
          value.gaps.add("video_capacity");
          return;
        }
        const previous = value.frames.at(-1);
        if (
          previous &&
          (previous.sequence >= frame.sequence ||
            previous.mediaTime.generation !== frame.mediaTime.generation ||
            previous.mediaTime.pts >= frame.mediaTime.pts ||
            previous.receivedAt >= frame.receivedAt ||
            previous.width !== frame.width ||
            previous.height !== frame.height)
        ) {
          counters.droppedFrames++;
          value.gaps.add("video_discontinuity");
          return;
        }
        const observation = entry.observations.get(frame.sequence);
        const tracking = entry.tracking.get(frame.sequence);
        value.videoRun = event.run;
        value.frames.push({
          ...frame,
          detections:
            observation?.mediaTime.pts === frame.mediaTime.pts &&
            observation.mediaTime.generation === frame.mediaTime.generation
              ? observation.detections.slice(0, 128)
              : null,
          tracks:
            tracking?.mediaTime.pts === frame.mediaTime.pts &&
            tracking.mediaTime.generation === frame.mediaTime.generation
              ? tracking.tracks
              : null,
        });
        value.bytes += size;
        bytes += size;
      } else if (
        (event.event === "settled" || event.event === "tracking") &&
        event.observation
      ) {
        const observation = event.observation;
        let found = false;
        for (const value of entry.drafts.values()) {
          if (!value.videoRun || !isCurrentRun(value.videoRun, event.run))
            continue;
          for (const frame of value.frames) {
            if (
              frame.sequence !== observation.sequence ||
              frame.mediaTime.pts !== observation.mediaTime.pts ||
              frame.mediaTime.generation !== observation.mediaTime.generation
            )
              continue;
            if (event.event === "tracking")
              frame.tracks = event.observation.tracks;
            else {
              frame.detections = event.observation.detections.slice(0, 128);
              if (event.observation.detections.length > 128)
                value.gaps.add("detections_truncated");
            }
            found = true;
          }
        }
        if (!found && observation.receivedAt < entry.lastClosedAt)
          counters.lateObservations++;
        if (event.event === "tracking") {
          entry.tracking.set(observation.sequence, event.observation);
          if (entry.tracking.size > 16)
            entry.tracking.delete(entry.tracking.keys().next().value!);
        } else {
          entry.observations.set(observation.sequence, {
            ...event.observation,
            detections: event.observation.detections.slice(0, 128),
          });
          if (entry.observations.size > 16)
            entry.observations.delete(entry.observations.keys().next().value!);
        }
      }
    },
    audio(
      track: z.infer<typeof audioTrackSchema>,
      pcm?: z.infer<typeof pcmSchema>,
    ) {
      for (const entry of sources.values()) {
        if (
          entry.run.deviceId !== track.run.deviceId ||
          entry.run.scopeEpoch !== track.run.scopeEpoch ||
          !track.channels.includes(entry.run.channel) ||
          !options.authorized(entry.run, entry.identity)
        )
          continue;
        entry.audioTrack = track;
        for (const value of entry.drafts.values())
          recordAudioStatus(value, track);
        if (!pcm || track.observedAt === null || track.validity !== "valid")
          continue;
        let offset = 0;
        while (offset < pcm.length) {
          const at = track.observedAt + offset / 16;
          const boundary =
            (Math.floor(at / windowLimits.durationMs) + 1) *
            windowLimits.durationMs;
          const end = Math.min(
            pcm.length,
            offset + Math.max(1, Math.ceil((boundary - at) * 16)),
          );
          const value = getDraft(entry, at);
          const size = (end - offset) * 2;
          if (
            value &&
            value.bytes + size <= windowLimits.windowBytes &&
            value.audio.length < 256 &&
            room(size)
          ) {
            const added = appendWindowAudio(value, track, pcm, offset, end, at);
            value.bytes += added;
            bytes += added;
          } else {
            counters.droppedAudio++;
            value?.gaps.add("audio_capacity");
          }
          offset = end;
        }
      }
    },
    describe(id: string, now: number) {
      const entry = lookup(id, now);
      return entry ? structuredClone(entry.summary) : undefined;
    },
    access(id: string, now: number) {
      const entry = lookup(id, now);
      return entry
        ? {
            inputState: entry.summary.inputState,
            readableUntil: entry.summary.readableUntil,
            signal: entry.controller.signal,
          }
        : undefined;
    },
    acquire(id: string, now: number) {
      const entry = lookup(id, now);
      if (!entry || entry.summary.inputState !== "available") return undefined;
      // Borrow only encoder pixels; the signal never exposes revocation authority.
      return {
        summary: structuredClone(entry.summary),
        signal: entry.controller.signal,
        input: {
          frames: entry.input.frames.map(
            ({ rgb, retainedWidth, retainedHeight }) => ({
              rgb,
              retainedWidth,
              retainedHeight,
            }),
          ),
          audio: entry.input.audio.map(({ pcm, startedAt }) => ({
            pcm,
            startedAt,
          })),
        },
      };
    },
    snapshot(now: number) {
      tick(now);
      return {
        windows: [...windows.values()]
          .filter((entry) => entry.summary.inputState !== "revoked")
          .map((entry) => structuredClone(entry.summary))
          .toReversed(),
        counters: { ...counters },
        retainedBytes: bytes,
        limits: windowLimits,
      };
    },
    close() {
      for (const id of sources.keys()) stop(id, true, Date.now());
      for (const entry of windows.values()) release(entry, "revoked");
      windows.clear();
    },
  };
}
