import { mijiaTimeouts } from "@home-agent/api/mijia";
import { RequestError } from "../../api/errors";
import {
  offerMijiaPlayback,
  releaseMijiaPlayback,
  reserveMijiaPlayback,
} from "./api";
import {
  beginPlaybackHistory,
  invalidatePlaybackHistory,
  recordPlaybackHistory,
} from "./history";

type PlaybackSnapshot = {
  phase: "connecting" | "waiting" | "playing" | "hidden" | "error";
  failure:
    | "unsupported_browser"
    | "negotiation_timeout"
    | "track_ended"
    | "autoplay_failed"
    | "connection_failed"
    | "first_frame_timeout"
    | "stalled_frame"
    | "negotiation_failed"
    | RequestError
    | null;
  playbackId: string | null;
  startedAt: number | null;
  answerAppliedAt: number | null;
  firstFrameAt: number | null;
  visible: boolean;
  visibilityVersion: number;
  historyContext: ReturnType<typeof beginPlaybackHistory> | null;
  connection:
    | Awaited<ReturnType<typeof offerMijiaPlayback>>["connection"]
    | null;
};

export const initialPlaybackSnapshot: PlaybackSnapshot = {
  phase: "connecting",
  failure: null,
  playbackId: null,
  startedAt: null,
  answerAppliedAt: null,
  firstFrameAt: null,
  visible: false,
  visibilityVersion: 0,
  historyContext: null,
  connection: null,
};

async function gatherIce(peer: RTCPeerConnection, signal: AbortSignal) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish();
      reject(new RequestError({ code: "ice_gathering_timeout" }));
    }, mijiaTimeouts.iceGathering);
    function finish() {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      signal.removeEventListener("abort", onAbort);
    }
    function onChange() {
      if (peer.iceGatheringState !== "complete") return;
      finish();
      resolve();
    }
    function onAbort() {
      finish();
      reject(new DOMException("Playback stopped", "AbortError"));
    }
    peer.addEventListener("icegatheringstatechange", onChange);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else onChange();
  });
}

/** Owns one browser viewer, its monotonic measurements and all media cleanup. */
export class PlaybackSession {
  private snapshot = initialPlaybackSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly controller = new AbortController();
  private peer: RTCPeerConnection | undefined;
  private stream: MediaStream | undefined;
  private frameCallback: number | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private negotiationDeadline: ReturnType<typeof setTimeout> | undefined;
  private visibilityObserver: IntersectionObserver | undefined;
  private visibilityKnown = false;
  private inViewport = false;
  private frameDeadline = 0;
  private firstFrameRecorded = false;
  private visibilityInterrupted = document.visibilityState !== "visible";
  private readonly video: HTMLVideoElement;
  private readonly target: Parameters<typeof beginPlaybackHistory>[0];
  private readonly scopeEpoch: string;

  constructor(
    video: HTMLVideoElement,
    { scope_epoch, ...target }: Parameters<typeof reserveMijiaPlayback>[0],
  ) {
    this.video = video;
    this.target = target;
    this.scopeEpoch = scope_epoch;
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(patch: Partial<PlaybackSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  start() {
    if (this.snapshot.startedAt !== null || this.controller.signal.aborted)
      return;
    this.update({
      startedAt: performance.now(),
      historyContext: beginPlaybackHistory(this.target),
    });
    void this.connect();
  }

  stop = () => {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    clearInterval(this.watchdog);
    clearTimeout(this.negotiationDeadline);
    this.visibilityObserver?.disconnect();
    document.removeEventListener("visibilitychange", this.updateVisibility);
    if (this.frameCallback !== undefined)
      this.video.cancelVideoFrameCallback(this.frameCallback);
    this.peer?.close();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.video.pause();
    this.video.srcObject = null;
    this.video.load();
    if (this.snapshot.playbackId)
      releaseMijiaPlayback(this.snapshot.playbackId);
    this.update({ playbackId: null, visible: false });
  };

  private fail(failure: NonNullable<PlaybackSnapshot["failure"]>) {
    if (this.controller.signal.aborted) return;
    if (
      this.snapshot.firstFrameAt === null &&
      this.snapshot.historyContext &&
      !this.visibilityInterrupted &&
      failure !== "unsupported_browser" &&
      failure !== "autoplay_failed" &&
      !(
        failure instanceof RequestError &&
        failure.details.code === "request_cancelled"
      )
    ) {
      invalidatePlaybackHistory(
        this.snapshot.historyContext,
        this.snapshot.connection?.sourceRecentlyActive ?? null,
      );
    }
    this.update({ phase: "error", failure });
    this.stop();
  }

  private waitForFrame() {
    this.frameDeadline =
      performance.now() +
      (this.snapshot.firstFrameAt === null
        ? mijiaTimeouts.firstFrame
        : mijiaTimeouts.stalledFrame);
    this.update({ phase: "waiting" });
  }

  private updateVisibility = () => {
    if (this.controller.signal.aborted) return;
    const visible = document.visibilityState === "visible" && this.inViewport;
    if (!visible && this.snapshot.firstFrameAt === null)
      this.visibilityInterrupted = true;
    if (this.visibilityKnown && visible === this.snapshot.visible) return;
    this.visibilityKnown = true;
    if (!visible) this.frameDeadline = 0;
    else if (this.snapshot.answerAppliedAt !== null)
      this.frameDeadline =
        performance.now() +
        (this.snapshot.firstFrameAt === null
          ? mijiaTimeouts.firstFrame
          : mijiaTimeouts.stalledFrame);
    this.update({
      visible,
      visibilityVersion: this.snapshot.visibilityVersion + 1,
      phase: !visible
        ? "hidden"
        : this.snapshot.answerAppliedAt !== null
          ? "waiting"
          : "connecting",
    });
  };

  private recordFirstFrame() {
    const {
      playbackId,
      answerAppliedAt,
      firstFrameAt,
      historyContext,
      connection,
    } = this.snapshot;
    if (
      this.controller.signal.aborted ||
      this.firstFrameRecorded ||
      !playbackId ||
      answerAppliedAt === null ||
      firstFrameAt === null ||
      historyContext === null ||
      connection?.sourceRecentlyActive == null
    )
      return;
    this.firstFrameRecorded = true;
    if (this.visibilityInterrupted) return;
    recordPlaybackHistory(historyContext, {
      ...this.target,
      id: playbackId,
      recordedAt: Date.now(),
      sourceRecentlyActive: connection.sourceRecentlyActive,
      firstFrameWaitMs: Math.max(0, firstFrameAt - answerAppliedAt),
    });
  }

  private onFrame = () => {
    if (this.controller.signal.aborted) return;
    if (this.snapshot.visible && document.visibilityState === "visible") {
      const now = performance.now();
      this.frameDeadline = now + mijiaTimeouts.stalledFrame;
      if (this.snapshot.firstFrameAt === null) {
        this.update({ firstFrameAt: now, phase: "playing" });
        this.recordFirstFrame();
      } else if (this.snapshot.phase !== "playing") {
        this.update({ phase: "playing" });
      }
    }
    this.frameCallback = this.video.requestVideoFrameCallback(this.onFrame);
  };

  private async connect() {
    if (
      typeof RTCPeerConnection !== "function" ||
      typeof MediaStream !== "function" ||
      typeof this.video.requestVideoFrameCallback !== "function"
    ) {
      this.fail("unsupported_browser");
      return;
    }
    try {
      const { signal } = this.controller;
      document.addEventListener("visibilitychange", this.updateVisibility);
      this.visibilityObserver = new IntersectionObserver(
        ([entry]) => {
          if (signal.aborted || !entry) return;
          this.inViewport = entry.isIntersecting && entry.intersectionRatio > 0;
          this.updateVisibility();
        },
        { threshold: [0, 0.01] },
      );
      this.visibilityObserver.observe(this.video);
      this.negotiationDeadline = setTimeout(
        () => this.fail("negotiation_timeout"),
        mijiaTimeouts.negotiation,
      );
      const stream = new MediaStream();
      this.stream = stream;
      const peer = new RTCPeerConnection({ iceServers: [] });
      this.peer = peer;
      peer.addTransceiver("video", { direction: "recvonly" });
      peer.addEventListener(
        "track",
        (event) => {
          if (signal.aborted) return;
          stream.addTrack(event.track);
          event.track.addEventListener(
            "ended",
            () => this.fail("track_ended"),
            {
              signal,
            },
          );
          this.video.srcObject = stream;
          void this.video.play().catch(() => this.fail("autoplay_failed"));
        },
        { signal },
      );
      peer.addEventListener(
        "connectionstatechange",
        () => {
          if (peer.connectionState === "failed") this.fail("connection_failed");
        },
        { signal },
      );
      this.frameCallback = this.video.requestVideoFrameCallback(this.onFrame);
      // Reservation must finish even after teardown, so its returned ID can be
      // released. It does not start media and runs alongside browser preparation.
      const [reservation] = await Promise.all([
        reserveMijiaPlayback({
          ...this.target,
          scope_epoch: this.scopeEpoch,
        }).then((result) => {
          if (signal.aborted) releaseMijiaPlayback(result.id);
          else this.update({ playbackId: result.id });
          return result;
        }),
        (async () => {
          await peer.setLocalDescription(await peer.createOffer());
          if (signal.aborted) return;
          await gatherIce(peer, signal);
        })(),
      ]);
      if (signal.aborted) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new RequestError({ code: "missing_local_sdp" });
      const result = await offerMijiaPlayback(
        reservation.id,
        { revision: this.target.revision, sdp },
        signal,
      );
      if (signal.aborted) return;
      await peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
      if (signal.aborted) return;
      this.update({
        answerAppliedAt: performance.now(),
        connection: result.connection,
      });
      clearTimeout(this.negotiationDeadline);
      this.recordFirstFrame();
      if (!this.snapshot.visible) this.update({ phase: "hidden" });
      else if (this.snapshot.phase !== "playing") this.waitForFrame();
      this.watchdog = setInterval(() => {
        if (
          signal.aborted ||
          !this.snapshot.visible ||
          document.visibilityState !== "visible"
        )
          return;
        if (performance.now() >= this.frameDeadline)
          this.fail(
            this.snapshot.firstFrameAt === null
              ? "first_frame_timeout"
              : "stalled_frame",
          );
      }, 1_000);
    } catch (error) {
      if (!this.controller.signal.aborted)
        this.fail(error instanceof RequestError ? error : "negotiation_failed");
    }
  }
}
