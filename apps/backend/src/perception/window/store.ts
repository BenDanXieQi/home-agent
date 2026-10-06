import { createWindowVideoObservations } from "./video-observations";
import { appendWindowPetSound } from "./pet-sound";
import type { z } from "zod";
import { type windowSourceSchema } from "@home-agent/api/contracts";
import type {
  audioTrackSchema,
  windowSummarySchema,
  speechObservationSchema,
  petSoundObservationSchema,
  audioObservationEventSchema,
} from "@home-agent/api/contracts";
import type { pcmSchema } from "../audio/pcm";
import {
  createWindowDraft,
  summarizeWindow,
  truncateWindow,
  windowIdentities,
  applyWindowAudioObservations,
  windowAdmitted,
  canCompareWindowFrames,
  windowComparisonInterval,
} from "./aggregate";
import { appendWindowSpeech, createWindowSpeech } from "./speech";
import {
  appendWindowAudio,
  recordAudioStatus,
  createWindowAudioContext,
} from "./audio-coverage";
import { petSoundPolicy, petSoundDeliveryDeadline } from "../pet-sound/limits";
import {
  sourceKey,
  type sourceSelectionSchema,
  type perceptionConfigSchema,
} from "../config";
import { isCurrentRun, type runSchema } from "../observations";
import type { videoEventSchema } from "../video/events";
import { windowLimits, windowAdmissionDeadline } from "./limits";

function source(run: z.infer<typeof runSchema>, identity: string, now: number) {
  return {
    run,
    videoRun: null as z.infer<typeof runSchema> | null,
    identity,
    startedAt: now,
    drafts: new Map<number, ReturnType<typeof createWindowDraft>>(),
    context: null as {
      frame: ReturnType<typeof createWindowDraft>["frames"][number];
      runId: string;
    } | null,
    audioTrack: null as z.infer<typeof audioTrackSchema> | null,
    audioContext: createWindowAudioContext(),
    analysis: new Map<string, z.infer<typeof audioObservationEventSchema>>(),
    videoObservations: createWindowVideoObservations(),
    lastClosedAt: -Infinity,
  };
}
// Only these fields can change when an observation reaches a closed window.
// Their serialized size delta is also the exact delta of the complete summary.
function analysisDescriptionBytes(
  summary: z.infer<typeof windowSummarySchema>,
) {
  return Buffer.byteLength(
    JSON.stringify({
      speech: summary.speech,
      petSounds: summary.audio.petSounds,
      candidate: summary.gate.candidate,
      audioPassed: summary.gate.audioPassed,
      revision: summary.revision,
      summaryUntil: summary.summaryUntil,
    }),
  );
}
function retained(
  summary: z.infer<typeof windowSummarySchema>,
  input: ReturnType<typeof createWindowDraft>,
  identity: string,
  identities: ReturnType<typeof windowIdentities>,
  petAcceptingUntil: number,
) {
  // Closed windows keep only encoder input; gray pixels and live facts belong
  // to aggregation. Freeze the shared metadata once before lending it to encoders.
  const frames = Object.freeze(
    summary.gate.candidate === "video"
      ? input.frames.map(({ rgb, retainedWidth, retainedHeight }) =>
          Object.freeze({ rgb, retainedWidth, retainedHeight }),
        )
      : [],
  );
  const audio = Object.freeze(
    (summary.gate.candidate !== "none" ||
      Math.max(summary.speech.acceptingUntil, petAcceptingUntil) >
        summary.closedAt) &&
      summary.audio.status === "available"
      ? input.audio.map(({ pcm, startedAt }) =>
          Object.freeze({ pcm, startedAt }),
        )
      : [],
  );
  return {
    summary,
    petAcceptingUntil,
    identities,
    input: { frames, audio },
    bytes:
      frames.reduce((total, frame) => total + frame.rgb.byteLength, 0) +
      audio.reduce((total, block) => total + block.pcm.byteLength, 0),
    identity,
    authorization: new AbortController(),
    descriptionBytes: Buffer.byteLength(JSON.stringify(summary)),
    analysisBytes: analysisDescriptionBytes(summary),
    expiresAt:
      performance.now() + Math.max(0, summary.readableUntil - summary.closedAt),
  };
}
type RetainedWindow = ReturnType<typeof retained>;

export function createWindowStore(options: {
  config: () => Pick<
    z.infer<typeof perceptionConfigSchema>,
    "window" | "speech" | "petSounds" | "maxFrameAgeMs" | "sampleFps"
  >;
  authorized: (run: z.infer<typeof runSchema>, identity: string) => boolean;
}) {
  const sources = new Map<string, ReturnType<typeof source>>();
  const windows = new Map<string, RetainedWindow>();
  // IDs only: the window remains the sole owner of retained evidence.
  const analysisWindows = new Map<string, Set<string>>();
  const readLeases = new Set<
    Pick<RetainedWindow, "identity" | "authorization"> & {
      run: RetainedWindow["summary"]["run"];
    }
  >();
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
    pendingAnalysisEvicted: 0,
    speechAssociations: 0,
    petSoundAssociations: 0,
  };
  const listeners = new Set<(id: string) => void>();
  const contentListeners = new Set<() => void>();
  let bytes = 0;
  let descriptionBytes = 0;
  function contentChanged() {
    for (const listener of contentListeners) {
      try {
        listener();
      } catch (cause) {
        console.error("Window content notification failed", cause);
      }
    }
  }
  function clearContext(entry: ReturnType<typeof source>) {
    if (!entry.context) return;
    bytes -=
      entry.context.frame.rgb.byteLength + entry.context.frame.gray.byteLength;
    entry.context = null;
  }
  function clearAudioContext(entry: ReturnType<typeof source>) {
    bytes -= entry.audioContext.audio.reduce(
      (sum, block) => sum + block.pcm.byteLength,
      0,
    );
    entry.audioContext = createWindowAudioContext();
  }
  function stopAcceptingAnalysis(entry: RetainedWindow) {
    const runId = entry.summary.audio.run?.trackRunId;
    if (!runId) return;
    const ids = analysisWindows.get(runId);
    ids?.delete(entry.summary.id);
    if (!ids?.size) analysisWindows.delete(runId);
  }
  function release(
    entry: RetainedWindow,
    reason: "expired" | "evicted" | "revoked",
    count = true,
  ) {
    if (reason === "revoked") {
      entry.authorization.abort(new Error("Window access revoked"));
      stopAcceptingAnalysis(entry);
    }
    const previous = entry.summary.inputState;
    const next =
      previous === "available" || reason === "revoked" ? reason : previous;
    // These enum values are ASCII strings; only their value length changes.
    const addedBytes = next.length - previous.length;
    entry.descriptionBytes += addedBytes;
    descriptionBytes += addedBytes;
    entry.summary.inputState = next;
    if (previous === "available") {
      if (count) counters[reason]++;
      bytes -= entry.bytes;
      entry.bytes = 0;
      entry.input.frames = [];
      entry.input.audio = [];
    }
    if (next !== previous) contentChanged();
  }
  function forget(id: string, entry: RetainedWindow) {
    stopAcceptingAnalysis(entry);
    release(entry, "expired");
    entry.authorization.abort(new Error("Window description removed"));
    descriptionBytes -= entry.descriptionBytes;
    windows.delete(id);
    contentChanged();
  }
  function limitDescriptions() {
    while (
      windows.size > windowLimits.summaries ||
      descriptionBytes > windowLimits.summaryBytes
    ) {
      const oldest = windows.keys().next().value!;
      forget(oldest, windows.get(oldest)!);
    }
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
      const draftCapacity = windowLimits.readyPerSource;
      if (entry.drafts.size >= draftCapacity) {
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
    const sampleFps = options.config().sampleFps;
    const firstFrame = value.frames[0];
    const lastFrame = value.frames.at(-1);
    const context = entry.context;
    if (
      firstFrame &&
      context &&
      context.runId === value.videoRun?.runId &&
      canCompareWindowFrames(context.frame, firstFrame, sampleFps) &&
      !value.gaps.has("capture_failed")
    ) {
      const size = context.frame.rgb.byteLength + context.frame.gray.byteLength;
      if (value.bytes + size <= windowLimits.windowBytes && room(size)) {
        value.frames.unshift(context.frame);
        value.bytes += size;
        bytes += size;
      } else value.gaps.add("video_context_capacity");
    }
    if (value.gaps.has("capture_failed")) clearContext(entry);
    else if (lastFrame && value.videoRun) {
      clearContext(entry);
      const size = lastFrame.rgb.byteLength + lastFrame.gray.byteLength;
      if (room(size)) {
        entry.context = { frame: lastFrame, runId: value.videoRun.runId };
        bytes += size;
      }
    }
    const resultSummary = summarizeWindow(value, entry, sampleFps);
    const summary: z.infer<typeof windowSummarySchema> = {
      id: crypto.randomUUID(),
      revision: 0,
      run: entry.run,
      videoRun: value.videoRun,
      generation: value.frames[0]?.mediaTime.generation ?? null,
      processingVersion: "media-window-1",
      startedAt: value.startedAt,
      endedAt: value.endedAt,
      closedAt: now,
      readableUntil: now + options.config().window.retentionMs,
      summaryUntil: now + windowLimits.mediaRetentionMs,
      timeBasis: "host_receive",
      synchronizationAccuracyMs: null,
      incomplete: value.incomplete,
      gaps: [...value.gaps],
      frames: value.frames.map(({ rgb: _rgb, gray: _gray, ...frame }) => frame),
      speech: createWindowSpeech(options.config(), value.endedAt),
      audio: resultSummary.audio,
      gate: resultSummary.gate,
      crop: resultSummary.crop,
      inputState: "available",
    };
    const petAcceptingUntil = options.config().petSounds.enabled
      ? petSoundDeliveryDeadline(value.endedAt, options.config().maxFrameAgeMs)
      : value.endedAt;
    for (const event of entry.analysis.values())
      appendAnalysis(summary, event, now, petAcceptingUntil);
    applyWindowAudioObservations(summary);
    const admitted = windowAdmitted(summary);
    entry.lastClosedAt = Math.max(entry.lastClosedAt, value.endedAt);
    if (!admitted) {
      counters.skipped++;
      // Keep bounded evidence while an independent analyzer can still admit it.
      if (
        now >= Math.max(summary.speech.acceptingUntil, petAcceptingUntil) ||
        !summary.audio.run ||
        summary.audio.startedAt === null ||
        summary.audio.endedAt === null
      ) {
        bytes -= value.bytes;
        return;
      }
      summary.frames = [];
      summary.crop = null;
      summary.gate.comparisons = [];
      summary.summaryUntil = Math.max(
        summary.speech.acceptingUntil,
        petAcceptingUntil,
      );
    } else counters.candidates++;
    const identities = windowIdentities(summary.frames);
    const result = retained(
      summary,
      value,
      entry.identity,
      identities,
      petAcceptingUntil,
    );
    bytes -= value.bytes - result.bytes;
    windows.set(summary.id, result);
    if (
      now < Math.max(summary.speech.acceptingUntil, petAcceptingUntil) &&
      summary.audio.run &&
      summary.audio.startedAt !== null &&
      summary.audio.endedAt !== null
    ) {
      const runId = summary.audio.run.trackRunId;
      const ids = analysisWindows.get(runId) ?? new Set<string>();
      ids.add(summary.id);
      analysisWindows.set(runId, ids);
    }
    counters.speechAssociations += summary.speech.segments.length;
    counters.petSoundAssociations +=
      summary.audio.petSounds?.chunks.length ?? 0;
    descriptionBytes += result.descriptionBytes;
    if (
      summary.gate.candidate === "none" &&
      now >= Math.max(summary.speech.acceptingUntil, petAcceptingUntil)
    ) {
      release(result, "evicted", false);
    }
    const ready = [...windows.values()].filter(
      (window) =>
        window.summary.run.deviceId === entry.run.deviceId &&
        window.summary.run.channel === entry.run.channel &&
        window.summary.inputState === "available",
    );
    while (ready.length > windowLimits.readyPerSource)
      release(ready.shift()!, "evicted");
    limitDescriptions();
    if (windows.has(summary.id) && admitted) contentChanged();
    if (
      windows.has(summary.id) &&
      admitted &&
      summary.gate.candidate !== "none"
    )
      for (const listener of listeners) listener(summary.id);
  }
  function tick(now: number) {
    for (const lease of readLeases)
      if (!options.authorized(lease.run, lease.identity))
        lease.authorization.abort(new Error("Window access revoked"));
    for (const [id, entry] of sources) {
      if (!options.authorized(entry.run, entry.identity)) {
        stop(id, true, now);
        continue;
      }
      if (
        entry.context &&
        now >
          entry.context.frame.receivedAt +
            windowComparisonInterval(options.config().sampleFps) +
            windowLimits.durationMs +
            windowLimits.graceMs
      )
        clearContext(entry);
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
      const earliest = now - windowLimits.durationMs - windowLimits.graceMs;
      entry.videoObservations.prune(earliest);
      for (const [observationId, event] of entry.analysis)
        if (event.observation.observedEndAt <= entry.lastClosedAt)
          entry.analysis.delete(observationId);
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
    if (
      now >=
        Math.max(
          entry.summary.speech.acceptingUntil,
          entry.petAcceptingUntil,
        ) ||
      entry.summary.inputState === "revoked"
    )
      stopAcceptingAnalysis(entry);
    if (
      now >=
        Math.max(
          entry.summary.speech.acceptingUntil,
          entry.petAcceptingUntil,
        ) &&
      !windowAdmitted(entry.summary)
    )
      release(entry, "evicted", false);
    if (now >= entry.summary.summaryUntil) {
      forget(id, entry);
    }
  }

  function lookup(id: string, now: number) {
    const entry = windows.get(id);
    if (entry) maintain(id, entry, now);
    const retainedEntry = windows.get(id);
    return retainedEntry && windowAdmitted(retainedEntry.summary)
      ? retainedEntry
      : undefined;
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
    clearContext(entry);
    clearAudioContext(entry);
  }
  function appendAnalysis(
    summary: RetainedWindow["summary"],
    event: z.infer<typeof audioObservationEventSchema>,
    now: number,
    petAcceptingUntil: number,
  ) {
    return event.kind === "speech"
      ? appendWindowSpeech(summary, event.observation, now)
      : appendWindowPetSound(
          summary,
          event.observation,
          now,
          petAcceptingUntil,
        );
  }
  function observe(event: Parameters<typeof appendAnalysis>[1], now: number) {
    const { observation } = event;
    if (
      event.kind === "speech"
        ? !options.config().speech.enabled || !event.observation.text.trim()
        : !options.config().petSounds.enabled
    )
      return;
    for (const entry of sources.values()) {
      const audio = entry.audioTrack;
      if (
        !audio ||
        entry.run.deviceId !== observation.run.deviceId ||
        entry.run.scopeEpoch !== observation.run.scopeEpoch ||
        audio.run.trackRunId !== observation.run.trackRunId ||
        audio.generation !== observation.generation ||
        !options.authorized(entry.run, entry.identity)
      )
        continue;
      if (observation.observedEndAt > entry.lastClosedAt) {
        entry.analysis.set(
          `${event.kind}:${observation.id}`,
          structuredClone(event),
        );
        if (entry.analysis.size > windowLimits.pendingAnalysisPerSource) {
          entry.analysis.delete(entry.analysis.keys().next().value!);
          counters.pendingAnalysisEvicted++;
        }
      }
    }
    for (const id of analysisWindows.get(observation.run.trackRunId) ?? []) {
      const entry = windows.get(id)!;
      maintain(id, entry, now);
      if (!windows.has(id) || entry.summary.inputState === "revoked") continue;
      const wasAdmitted = windowAdmitted(entry.summary);
      const previousSegments = entry.summary.speech.segments.length;
      const previousSounds = entry.summary.audio.petSounds?.chunks.length ?? 0;
      if (!appendAnalysis(entry.summary, event, now, entry.petAcceptingUntil))
        continue;
      const admitted = windowAdmitted(entry.summary);
      if (!wasAdmitted && admitted) {
        counters.candidates++;
        counters.skipped--;
      }
      counters.speechAssociations +=
        entry.summary.speech.segments.length - previousSegments;
      counters.petSoundAssociations +=
        (entry.summary.audio.petSounds?.chunks.length ?? 0) - previousSounds;
      applyWindowAudioObservations(entry.summary);
      entry.summary.revision++;
      if (admitted)
        entry.summary.summaryUntil =
          entry.summary.closedAt + windowLimits.mediaRetentionMs;
      const analysisBytes = analysisDescriptionBytes(entry.summary);
      const addedBytes = analysisBytes - entry.analysisBytes;
      entry.analysisBytes = analysisBytes;
      descriptionBytes += addedBytes;
      entry.descriptionBytes += addedBytes;
      if (admitted) contentChanged();
      if (!wasAdmitted && admitted && entry.summary.inputState === "available")
        for (const listener of listeners) listener(id);
    }
    limitDescriptions();
  }
  return {
    speech(observation: z.infer<typeof speechObservationSchema>, now: number) {
      observe({ kind: "speech", observation }, now);
    },
    petSound(
      observation: z.infer<typeof petSoundObservationSchema>,
      now: number,
    ) {
      observe({ kind: "pet_sound", observation }, now);
    },
    subscribe(listener: (id: string) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeContent(listener: () => void) {
      contentListeners.add(listener);
      return () => {
        contentListeners.delete(listener);
      };
    },
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
      clearContext(entry);
      entry.videoObservations.clear();
      entry.videoRun = run;
    },
    stopVideo(runId: string) {
      for (const entry of sources.values()) {
        if (entry.videoRun?.runId !== runId) continue;
        clearContext(entry);
        entry.videoObservations.clear();
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
          now >= windowAdmissionDeadline(frame.receivedAt)
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
        const associated = entry.videoObservations.associate(event.run, frame);
        if (associated.truncated) value.gaps.add("detections_truncated");
        value.videoRun = event.run;
        value.frames.push({ ...frame, ...associated.facts });
        value.bytes += size;
        bytes += size;
      } else if (
        event.event === "identity_frame" ||
        event.event === "settled" ||
        event.event === "tracking"
      ) {
        if (
          entry.videoObservations.accept(
            event,
            now,
            entry.lastClosedAt,
            entry.drafts.values(),
          ) === "late"
        )
          counters.lateObservations++;
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
        const contextTrack = entry.audioContext.audioTrack;
        if (
          !track.petSounds ||
          (contextTrack &&
            (contextTrack.run.trackRunId !== track.run.trackRunId ||
              contextTrack.generation !== track.generation))
        )
          clearAudioContext(entry);
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
          if (value && !value.audio.length && track.petSounds) {
            const context = entry.audioContext.audio;
            const contextBytes = context.reduce(
              (sum, block) => sum + block.pcm.byteLength,
              0,
            );
            if (
              value.bytes + contextBytes + size <= windowLimits.windowBytes &&
              room(contextBytes + size)
            ) {
              value.audio = context.map((block) => ({ ...block }));
              value.audioTrack = entry.audioContext.audioTrack;
              value.bytes += contextBytes;
              bytes += contextBytes;
            }
          }
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
          if (track.petSounds) {
            if (room(size)) {
              bytes += appendWindowAudio(
                entry.audioContext,
                track,
                pcm,
                offset,
                end,
                at,
              );
              const earliest =
                at + (end - offset) / 16 - petSoundPolicy.contextMs;
              while (
                entry.audioContext.audio[0] &&
                entry.audioContext.audio[0].endedAt <= earliest
              )
                bytes -= entry.audioContext.audio.shift()!.pcm.byteLength;
            } else clearAudioContext(entry);
          }
          offset = end;
        }
      }
    },
    describe(id: string, now: number) {
      const entry = lookup(id, now);
      return entry ? structuredClone(entry.summary) : undefined;
    },
    *selectDetails(
      now: number,
      selection: {
        matches: (
          summary: Readonly<z.infer<typeof windowSummarySchema>>,
        ) => boolean;
        after?: Pick<z.infer<typeof windowSummarySchema>, "startedAt" | "id">;
        limit: number;
      },
    ) {
      for (const [id, entry] of windows) maintain(id, entry, now);
      const selected = [...windows.values()]
        .filter(
          ({ summary }) =>
            windowAdmitted(summary) &&
            summary.inputState !== "revoked" &&
            (!selection.after ||
              summary.startedAt > selection.after.startedAt ||
              (summary.startedAt === selection.after.startedAt &&
                summary.id > selection.after.id)) &&
            selection.matches(summary),
        )
        .toSorted(
          ({ summary: left }, { summary: right }) =>
            left.startedAt - right.startedAt ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        )
        .slice(0, selection.limit)
        .map(({ summary }) => summary.id);
      for (const id of selected) {
        const entry = lookup(id, now);
        if (entry && entry.summary.inputState !== "revoked")
          yield structuredClone(entry.summary);
      }
    },
    access(id: string, now: number) {
      const entry = lookup(id, now);
      return entry
        ? {
            inputState: entry.summary.inputState,
          }
        : undefined;
    },
    acquireRead(id: string, now: number) {
      const entry = lookup(id, now);
      if (!entry || entry.summary.inputState === "revoked") return undefined;
      // An admitted read retains authorization independently of the window summary.
      const lease = {
        run: entry.summary.run,
        identity: entry.identity,
        authorization: new AbortController(),
      };
      readLeases.add(lease);
      return {
        signal: lease.authorization.signal,
        release() {
          readLeases.delete(lease);
        },
      };
    },
    acquire(id: string, now: number) {
      const entry = lookup(id, now);
      if (!entry || entry.summary.inputState !== "available") return undefined;
      // Borrow only encoder pixels; the signal never exposes revocation authority.
      return {
        authorizationSignal: entry.authorization.signal,
        bytes: entry.bytes,
        input: { ...entry.input },
      };
    },
    snapshot(now: number, selection: z.infer<typeof windowSourceSchema>) {
      tick(now);
      return {
        windows: [...windows.values()]
          .filter(
            ({ summary }) =>
              windowAdmitted(summary) &&
              summary.inputState !== "revoked" &&
              summary.run.scopeEpoch === selection.scopeEpoch &&
              summary.run.deviceId === selection.deviceId &&
              summary.run.channel === selection.channel,
          )
          .map(({ summary, identities }) => ({
            id: summary.id,
            revision: summary.revision,
            run: { ...summary.run },
            videoRun: summary.videoRun ? { ...summary.videoRun } : null,
            startedAt: summary.startedAt,
            endedAt: summary.endedAt,
            readableUntil: summary.readableUntil,
            summaryUntil: summary.summaryUntil,
            speechCount: summary.speech.segments.length,
            petSoundKinds: summary.audio.petSounds && [
              ...new Set(
                summary.audio.petSounds.chunks.flatMap((chunk) =>
                  chunk.detections.map((detection) => detection.kind),
                ),
              ),
            ],
            ...identities,
            identityLabels: [...identities.identityLabels],
            gate: structuredClone(summary.gate),
            incomplete: summary.incomplete,
            inputState: summary.inputState,
          }))
          .toReversed(),
        counters: { ...counters },
        retainedBytes: bytes,
        summaryBytes: descriptionBytes,
        limits: windowLimits,
      };
    },
    close() {
      for (const lease of readLeases)
        lease.authorization.abort(new Error("Window store closed"));
      readLeases.clear();
      for (const id of sources.keys()) stop(id, true, Date.now());
      for (const entry of windows.values()) {
        release(entry, "revoked");
      }
      windows.clear();
      analysisWindows.clear();
      listeners.clear();
      contentListeners.clear();
      descriptionBytes = 0;
    },
  };
}
