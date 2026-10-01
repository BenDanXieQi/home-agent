/// <reference types="dom-mediacapture-transform" />
import { z } from "zod";
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

const sourceFrameMetadata = z.object({
  rtpTimestamp: z.int().min(0).max(0xffffffff),
});

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

type PlaybackSurface = {
  element: HTMLVideoElement | HTMLCanvasElement;
  onFrame?: (input: {
    frame: VideoFrame;
    media: Awaited<ReturnType<typeof offerMijiaPlayback>>["media"];
    availableAt: number;
    rtpTimestamp: number;
  }) => void;
};

/** Owns one connection; video and canvas surfaces can take turns displaying it. */
export class PlaybackSession {
  private frameReader: ReadableStreamDefaultReader<VideoFrame> | undefined;
  private media:
    | Awaited<ReturnType<typeof offerMijiaPlayback>>["media"]
    | undefined;
  private surface: PlaybackSurface | undefined;
  private frameTrack: MediaStreamTrack | undefined;
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
  private readonly target: Parameters<typeof beginPlaybackHistory>[0];
  private readonly scopeEpoch: string;

  constructor({
    scope_epoch,
    ...target
  }: Parameters<typeof reserveMijiaPlayback>[0]) {
    this.target = target;
    this.scopeEpoch = scope_epoch;
  }

  private get video() {
    return this.surface?.element instanceof HTMLVideoElement
      ? this.surface.element
      : undefined;
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get stopped() {
    return this.controller.signal.aborted;
  }

  attach(surface: PlaybackSurface) {
    this.detach();
    this.surface = surface;
    this.visibilityKnown = false;
    this.inViewport = false;
    this.visibilityObserver?.observe(surface.element);
    this.updateVisibility();
    this.displayStream();
    return () => {
      if (this.surface === surface) this.detach();
    };
  }

  private detach() {
    this.visibilityObserver?.disconnect();
    if (this.frameCallback !== undefined)
      this.video?.cancelVideoFrameCallback(this.frameCallback);
    this.frameCallback = undefined;
    const reader = this.frameReader;
    this.frameReader = undefined;
    reader?.cancel().catch((error: unknown) => {
      console.error("Playback frame reader cleanup failed", error);
    });
    this.frameTrack?.stop();
    this.frameTrack = undefined;
    const video = this.video;
    if (video) {
      video.pause();
      video.srcObject = null;
      video.load();
    }
    this.surface = undefined;
    this.inViewport = false;
    this.updateVisibility();
  }

  private displayStream() {
    if (!this.surface || !this.stream?.getVideoTracks().length || this.stopped)
      return;
    if (this.surface.onFrame) {
      if (typeof MediaStreamTrackProcessor !== "function") {
        this.fail("unsupported_browser");
        return;
      }
      // Cancelling the canvas reader must not end the reusable receiver track.
      const track = this.stream.getVideoTracks()[0]!.clone();
      this.frameTrack = track;
      this.readFrames(track).catch((error: unknown) => {
        if (!this.stopped && this.frameTrack === track) {
          console.error("Playback frame reader failed", error);
          this.fail("negotiation_failed");
        }
      });
    } else {
      const video = this.video;
      if (!video || typeof video.requestVideoFrameCallback !== "function") {
        this.fail("unsupported_browser");
        return;
      }
      const surface = this.surface;
      video.srcObject = this.stream;
      video.play().catch(() => {
        if (this.surface === surface && !this.stopped)
          this.fail("autoplay_failed");
      });
      this.frameCallback = video.requestVideoFrameCallback(this.onFrame);
    }
  }

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
    this.connect().catch((backgroundError: unknown) => {
      console.error("session: connect failed", backgroundError);
    });
  }

  stop = () => {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    clearInterval(this.watchdog);
    clearTimeout(this.negotiationDeadline);
    this.visibilityObserver?.disconnect();
    document.removeEventListener("visibilitychange", this.updateVisibility);
    this.detach();
    this.peer?.close();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
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

  private receivedFrame() {
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
  }

  private onFrame = () => {
    this.receivedFrame();
    if (!this.controller.signal.aborted && this.video)
      this.frameCallback = this.video?.requestVideoFrameCallback(this.onFrame);
  };

  private async readFrames(track: MediaStreamVideoTrack) {
    const reader = new MediaStreamTrackProcessor({
      track,
      maxBufferSize: 1,
    }).readable.getReader();
    this.frameReader = reader;
    try {
      while (!this.controller.signal.aborted && this.frameReader === reader) {
        const { done, value: frame } = await reader.read();
        if (done) break;
        try {
          if (this.controller.signal.aborted || this.frameReader !== reader)
            break;
          if (frame.displayWidth * frame.displayHeight > 1920 * 1080)
            throw new Error("Video exceeds presentation pixel limit");
          if (
            !this.media ||
            !("metadata" in frame) ||
            typeof frame.metadata !== "function"
          )
            throw new Error("Source frame metadata unavailable");
          const { rtpTimestamp } = sourceFrameMetadata.parse(frame.metadata());
          this.receivedFrame();
          this.surface?.onFrame?.({
            frame,
            media: this.media,
            rtpTimestamp,
            availableAt: performance.now(),
          });
        } finally {
          frame.close();
        }
      }
      if (!this.controller.signal.aborted && this.frameReader === reader)
        this.fail("track_ended");
    } finally {
      reader.releaseLock();
      if (this.frameReader === reader) this.frameReader = undefined;
    }
  }

  private async connect() {
    if (
      typeof RTCPeerConnection !== "function" ||
      typeof MediaStream !== "function"
    ) {
      this.fail("unsupported_browser");
      return;
    }
    try {
      const { signal } = this.controller;
      document.addEventListener("visibilitychange", this.updateVisibility);
      this.visibilityObserver = new IntersectionObserver(
        ([entry]) => {
          if (
            signal.aborted ||
            !entry ||
            entry.target !== this.surface?.element
          )
            return;
          this.inViewport = entry.isIntersecting && entry.intersectionRatio > 0;
          this.updateVisibility();
        },
        { threshold: [0, 0.01] },
      );
      if (this.surface) this.visibilityObserver.observe(this.surface.element);
      this.negotiationDeadline = setTimeout(
        () => this.fail("negotiation_timeout"),
        mijiaTimeouts.negotiation,
      );
      const stream = new MediaStream();
      this.stream = stream;
      const peer = new RTCPeerConnection({ iceServers: [] });
      this.peer = peer;
      peer.addTransceiver("video", {
        direction: "recvonly",
      });
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
          this.displayStream();
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
      this.media = result.media;
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
