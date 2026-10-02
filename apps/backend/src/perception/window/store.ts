import type { z } from "zod";
import { type windowSourceSchema } from "@home-agent/api/contracts";
import type {
  audioTrackSchema,
  windowSummarySchema,
  speechObservationSchema,
} from "@home-agent/api/contracts";
import type { pcmSchema } from "../audio/pcm";
import {
  createWindowDraft,
  summarizeWindow,
  truncateWindow,
  windowIdentities,
} from "./aggregate";
import { appendWindowSpeech, createWindowSpeech } from "./speech";
import { appendWindowAudio, recordAudioStatus } from "./audio-coverage";
import {
  sourceKey,
  type sourceSelectionSchema,
  type perceptionConfigSchema,
} from "../config";
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
    speech: new Map<string, z.infer<typeof speechObservationSchema>>(),
    observations: new Map<
      number,
      z.infer<typeof observationSchema> & { truncated: boolean }
    >(),
    tracking: new Map<
      number,
      Extract<
        z.infer<typeof videoEventSchema>,
        { event: "tracking" }
      >["observation"]
    >(),
    identityFrames: new Map<
      number,
      Extract<z.infer<typeof videoEventSchema>, { event: "identity_frame" }>
    >(),
    lastClosedAt: -Infinity,
  };
}
function sameIdentityFrame(
  frame: Extract<
    z.infer<typeof videoEventSchema>,
    { event: "identity_frame" }
  >["frame"],
  other: typeof frame,
) {
  return (
    frame.sequence === other.sequence &&
    frame.receivedAt === other.receivedAt &&
    frame.mediaTime.generation === other.mediaTime.generation &&
    frame.mediaTime.pts === other.mediaTime.pts &&
    frame.width === other.width &&
    frame.height === other.height
  );
}
function retained(
  summary: z.infer<typeof windowSummarySchema>,
  input: ReturnType<typeof createWindowDraft>,
  identity: string,
  identities: ReturnType<typeof windowIdentities>,
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
    summary.audio.status === "available"
      ? input.audio.map(({ pcm, startedAt }) =>
          Object.freeze({ pcm, startedAt }),
        )
      : [],
  );
  return {
    summary,
    identities,
    input: { frames, audio },
    bytes:
      frames.reduce((total, frame) => total + frame.rgb.byteLength, 0) +
      audio.reduce((total, block) => total + block.pcm.byteLength, 0),
    identity,
    authorization: new AbortController(),
    descriptionBytes: Buffer.byteLength(JSON.stringify(summary)),
    expiresAt:
      performance.now() + Math.max(0, summary.readableUntil - summary.closedAt),
  };
}
type RetainedWindow = ReturnType<typeof retained>;

function speechDescriptionBytes(summary: RetainedWindow["summary"]) {
  const { speech, revision, summaryUntil } = summary;
  return Buffer.byteLength(JSON.stringify({ speech, revision, summaryUntil }));
}

export function createWindowStore(options: {
  config: () => Pick<
    z.infer<typeof perceptionConfigSchema>,
    "window" | "speech" | "maxFrameAgeMs"
  >;
  authorized: (run: z.infer<typeof runSchema>, identity: string) => boolean;
}) {
  const sources = new Map<string, ReturnType<typeof source>>();
  const windows = new Map<string, RetainedWindow>();
  // IDs only: the window remains the sole owner of retained evidence.
  const speechWindows = new Map<string, Set<string>>();
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
    pendingSpeechEvicted: 0,
    speechAssociations: 0,
  };
  const listeners = new Set<(id: string) => void>();
  let bytes = 0;
  let descriptionBytes = 0;
  function stopAcceptingSpeech(entry: RetainedWindow) {
    const runId = entry.summary.audio.run?.trackRunId;
    if (!runId) return;
    const ids = speechWindows.get(runId);
    ids?.delete(entry.summary.id);
    if (!ids?.size) speechWindows.delete(runId);
  }
  function release(
    entry: RetainedWindow,
    reason: "expired" | "evicted" | "revoked",
    count = true,
  ) {
    if (reason === "revoked") {
      entry.authorization.abort(new Error("Window access revoked"));
      stopAcceptingSpeech(entry);
    }
    const previous = entry.summary.inputState;
    const next =
      previous === "available" || reason === "revoked" ? reason : previous;
    // These enum values are ASCII strings; only their value length changes.
    const addedBytes = next.length - previous.length;
    entry.descriptionBytes += addedBytes;
    descriptionBytes += addedBytes;
    entry.summary.inputState = next;
    if (previous !== "available") return;
    if (count) counters[reason]++;
    bytes -= entry.bytes;
    entry.bytes = 0;
    entry.input.frames = [];
    entry.input.audio = [];
  }
  function forget(id: string, entry: RetainedWindow) {
    stopAcceptingSpeech(entry);
    release(entry, "expired");
    entry.authorization.abort(new Error("Window description removed"));
    descriptionBytes -= entry.descriptionBytes;
    windows.delete(id);
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
      revision: 0,
      run: entry.run,
      videoRun: value.videoRun,
      generation: value.frames[0]?.mediaTime.generation ?? null,
      processingVersion: "media-window-1",
      startedAt: value.startedAt,
      endedAt: value.endedAt,
      closedAt: now,
      readableUntil: now + options.config().window.retentionMs,
      summaryUntil:
        now +
        (resultSummary.gate.candidate === "none"
          ? windowLimits.summaryMs
          : windowLimits.mediaRetentionMs),
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
    for (const observation of entry.speech.values())
      appendWindowSpeech(summary, observation, now);
    const identities = windowIdentities(summary.frames);
    summary.summaryUntil = Math.max(
      summary.summaryUntil,
      summary.speech.acceptingUntil,
      summary.speech.segments.length || identities.identityCount
        ? now + windowLimits.mediaRetentionMs
        : 0,
    );
    const result = retained(summary, value, entry.identity, identities);
    bytes -= value.bytes - result.bytes;
    windows.set(summary.id, result);
    if (
      summary.speech.enabled &&
      now < summary.speech.acceptingUntil &&
      summary.audio.run &&
      summary.audio.startedAt !== null &&
      summary.audio.endedAt !== null
    ) {
      const runId = summary.audio.run.trackRunId;
      const ids = speechWindows.get(runId) ?? new Set<string>();
      ids.add(summary.id);
      speechWindows.set(runId, ids);
    }
    counters.speechAssociations += summary.speech.segments.length;
    descriptionBytes += result.descriptionBytes;
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
    limitDescriptions();
    entry.lastClosedAt = Math.max(entry.lastClosedAt, value.endedAt);
    if (windows.has(summary.id) && summary.gate.candidate !== "none")
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
      for (const results of [entry.observations, entry.tracking])
        for (const [sequence, observation] of results)
          if (observation.receivedAt < earliest) results.delete(sequence);
      for (const [sequence, event] of entry.identityFrames)
        if (event.frame.receivedAt < earliest)
          entry.identityFrames.delete(sequence);
      for (const [observationId, observation] of entry.speech)
        if (observation.observedEndAt <= entry.lastClosedAt)
          entry.speech.delete(observationId);
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
      now >= entry.summary.speech.acceptingUntil ||
      entry.summary.inputState === "revoked"
    )
      stopAcceptingSpeech(entry);
    if (now >= entry.summary.summaryUntil) {
      forget(id, entry);
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
    speech(observation: z.infer<typeof speechObservationSchema>, now: number) {
      if (!options.config().speech.enabled || !observation.text.trim()) return;
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
          entry.speech.set(observation.id, structuredClone(observation));
          if (entry.speech.size > windowLimits.pendingSpeechPerSource) {
            entry.speech.delete(entry.speech.keys().next().value!);
            counters.pendingSpeechEvicted++;
          }
        }
      }
      for (const id of speechWindows.get(observation.run.trackRunId) ?? []) {
        const entry = windows.get(id)!;
        maintain(id, entry, now);
        if (!windows.has(id) || entry.summary.inputState === "revoked")
          continue;
        const previousBytes = speechDescriptionBytes(entry.summary);
        const previousSegments = entry.summary.speech.segments.length;
        if (!appendWindowSpeech(entry.summary, observation, now)) continue;
        counters.speechAssociations +=
          entry.summary.speech.segments.length - previousSegments;
        entry.summary.revision++;
        entry.summary.summaryUntil =
          entry.summary.closedAt + windowLimits.mediaRetentionMs;
        const addedBytes =
          speechDescriptionBytes(entry.summary) - previousBytes;
        descriptionBytes += addedBytes;
        entry.descriptionBytes += addedBytes;
      }
      limitDescriptions();
    },
    subscribe(listener: (id: string) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
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
      entry.observations.clear();
      entry.tracking.clear();
      entry.identityFrames.clear();
      entry.videoRun = run;
    },
    stopVideo(runId: string) {
      for (const entry of sources.values()) {
        if (entry.videoRun?.runId !== runId) continue;
        entry.observations.clear();
        entry.tracking.clear();
        entry.identityFrames.clear();
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
        const identity = entry.identityFrames.get(frame.sequence);
        entry.observations.delete(frame.sequence);
        entry.tracking.delete(frame.sequence);
        const detections =
          observation?.mediaTime.pts === frame.mediaTime.pts &&
          observation.mediaTime.generation === frame.mediaTime.generation
            ? observation.detections
            : null;
        if (detections && observation?.truncated)
          value.gaps.add("detections_truncated");
        value.videoRun = event.run;
        value.frames.push({
          ...frame,
          detections,
          tracks:
            tracking?.mediaTime.pts === frame.mediaTime.pts &&
            tracking.mediaTime.generation === frame.mediaTime.generation
              ? tracking.tracks
              : null,
          identity:
            identity &&
            isCurrentRun(identity.run, event.run) &&
            sameIdentityFrame(identity.frame, frame)
              ? identity.identity
              : null,
        });
        value.bytes += size;
        bytes += size;
      } else if (event.event === "identity_frame") {
        const frame = event.frame;
        const deadline =
          (Math.floor(frame.receivedAt / windowLimits.durationMs) + 1) *
            windowLimits.durationMs +
          windowLimits.graceMs;
        if (frame.receivedAt > now) return;
        if (frame.receivedAt < entry.lastClosedAt || now >= deadline) {
          counters.lateObservations++;
          return;
        }
        // A frame owns its first frozen judgment; later inference cannot revise it.
        if (entry.identityFrames.has(frame.sequence)) return;
        const snapshot = structuredClone(event);
        for (const value of entry.drafts.values()) {
          if (!value.videoRun || !isCurrentRun(value.videoRun, event.run))
            continue;
          for (const retainedFrame of value.frames) {
            if (
              retainedFrame.identity === null &&
              sameIdentityFrame(frame, retainedFrame)
            )
              retainedFrame.identity = snapshot.identity;
          }
        }
        entry.identityFrames.set(frame.sequence, snapshot);
        if (entry.identityFrames.size > 16)
          entry.identityFrames.delete(
            entry.identityFrames.keys().next().value!,
          );
      } else if (
        (event.event === "settled" || event.event === "tracking") &&
        event.observation
      ) {
        const observation = event.observation;
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
            return;
          }
        }
        if (observation.receivedAt < entry.lastClosedAt) {
          counters.lateObservations++;
          return;
        }
        if (event.event === "tracking") {
          entry.tracking.set(observation.sequence, event.observation);
          if (entry.tracking.size > 16)
            entry.tracking.delete(entry.tracking.keys().next().value!);
        } else {
          entry.observations.set(observation.sequence, {
            ...event.observation,
            detections: event.observation.detections.slice(0, 128),
            truncated: event.observation.detections.length > 128,
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
              summary.inputState !== "revoked" &&
              summary.run.scopeEpoch === selection.scopeEpoch &&
              summary.run.deviceId === selection.deviceId &&
              summary.run.channel === selection.channel,
          )
          .map(({ summary, identities }) => ({
            id: summary.id,
            revision: summary.revision,
            run: { ...summary.run },
            startedAt: summary.startedAt,
            endedAt: summary.endedAt,
            readableUntil: summary.readableUntil,
            summaryUntil: summary.summaryUntil,
            speechCount: summary.speech.segments.length,
            ...identities,
            identityLabels: [...identities.identityLabels],
            gate: { ...summary.gate },
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
      speechWindows.clear();
      listeners.clear();
      descriptionBytes = 0;
    },
  };
}
