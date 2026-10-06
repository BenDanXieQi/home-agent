import type { z } from "zod";
import type { windowFrameSchema } from "@home-agent/api/contracts";
import { isCurrentRun, type runSchema } from "../observations";
import type { videoEventSchema } from "../video/events";
import type { createWindowDraft } from "./aggregate";
import { windowLimits, windowAdmissionDeadline } from "./limits";

type Event = Extract<
  z.infer<typeof videoEventSchema>,
  { event: "settled" | "tracking" | "identity_frame" }
>;
type Frame = z.infer<typeof windowFrameSchema>;
function frameOf(event: Event) {
  return event.event === "identity_frame" ? event.frame : event.observation;
}
function frameKey(
  frame: Pick<
    Frame,
    "sequence" | "receivedAt" | "mediaTime" | "width" | "height"
  >,
) {
  return [
    frame.sequence,
    frame.receivedAt,
    frame.mediaTime.generation,
    frame.mediaTime.pts,
    frame.mediaTime.rtpTimestamp,
    frame.width,
    frame.height,
  ].join(":");
}

// One owner for early and late video observations. Closed frame judgments are
// immutable; all analyzers use the same exact frame identity and admission bound.
export function createWindowVideoObservations() {
  const pending = new Map<
    Event["event"],
    Map<string, { event: Event; truncated: boolean }>
  >();
  function apply(
    target: Pick<Frame, "detections" | "tracks" | "identity">,
    value: { event: Event; truncated: boolean },
  ) {
    const { event } = value;
    if (event.event === "identity_frame" && target.identity === null)
      target.identity = structuredClone(event.identity);
    else if (event.event === "tracking" && target.tracks === null)
      target.tracks = structuredClone(event.observation.tracks);
    else if (
      event.event === "settled" &&
      event.observation &&
      target.detections === null
    ) {
      target.detections = structuredClone(event.observation.detections);
      return value.truncated;
    }
    return false;
  }
  return {
    accept(
      event: Event,
      now: number,
      lastClosedAt: number,
      drafts: Iterable<ReturnType<typeof createWindowDraft>>,
    ) {
      const frame = frameOf(event);
      if (
        !frame ||
        (event.event !== "identity_frame" &&
          event.observation &&
          !isCurrentRun(event.run, event.observation.run))
      )
        return "ignored" as const;
      const deadline = windowAdmissionDeadline(frame.receivedAt);
      if (frame.receivedAt > now) return "ignored" as const;
      if (frame.receivedAt < lastClosedAt || now >= deadline)
        return "late" as const;
      const key = frameKey(frame);
      const bucket =
        pending.get(event.event) ??
        new Map<string, { event: Event; truncated: boolean }>();
      if (bucket.has(key)) return "ignored" as const;
      const snapshot = structuredClone(event);
      const truncated =
        snapshot.event === "settled" &&
        !!snapshot.observation &&
        snapshot.observation.detections.length > 128;
      if (snapshot.event === "settled" && snapshot.observation)
        snapshot.observation.detections = snapshot.observation.detections.slice(
          0,
          128,
        );
      const value = { event: snapshot, truncated };
      bucket.set(key, value);
      if (bucket.size > windowLimits.pendingVideoPerKind)
        bucket.delete(bucket.keys().next().value!);
      pending.set(event.event, bucket);
      for (const draft of drafts) {
        if (!draft.videoRun || !isCurrentRun(draft.videoRun, event.run))
          continue;
        for (const retained of draft.frames)
          if (frameKey(retained) === key && apply(retained, value))
            draft.gaps.add("detections_truncated");
      }
      return "accepted" as const;
    },
    associate(
      run: z.infer<typeof runSchema>,
      frame: Parameters<typeof frameKey>[0],
    ) {
      const facts: Pick<Frame, "detections" | "tracks" | "identity"> = {
        detections: null,
        tracks: null,
        identity: null,
      };
      let truncated = false;
      for (const bucket of pending.values()) {
        const value = bucket.get(frameKey(frame));
        if (value && isCurrentRun(value.event.run, run))
          truncated = apply(facts, value) || truncated;
      }
      return { facts, truncated };
    },
    prune(earliest: number) {
      for (const bucket of pending.values())
        for (const [key, value] of bucket) {
          const frame = frameOf(value.event);
          if (!frame || frame.receivedAt < earliest) bucket.delete(key);
        }
    },
    clear() {
      pending.clear();
    },
  };
}
