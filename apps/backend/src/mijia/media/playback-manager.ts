import { createHash } from "node:crypto";
import { AppError } from "@home-agent/api/errors";
import {
  mijiaTimeouts,
  type MijiaPlaybackResponse,
} from "@home-agent/api/mijia";
import { context, ROOT_CONTEXT } from "@home-agent/observability";
import type { Go2RtcAdapter } from "./go2rtc-adapter";
import type { CameraSourceManager } from "./camera-source-manager";
import { MijiaError } from "../errors";
import { mijiaOperation } from "../operation";

type CameraTarget = Awaited<ReturnType<CameraSourceManager["prepare"]>>;
type Reservation = {
  phase: "reserved";
  id: string;
  revision: string;
  deviceId: string;
  channel: 1 | 2;
  timer: ReturnType<typeof setTimeout>;
};
type Playback = {
  phase: "negotiating" | "active";
  id: string;
  revision: string;
  offerFingerprint: string;
  result: Promise<MijiaPlaybackResponse>;
  answer?: MijiaPlaybackResponse;
  timer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
  target?: CameraTarget;
};
type PrepareCamera = (
  revision: string,
  deviceId: string,
  channel: 1 | 2,
  signal: AbortSignal,
) => Promise<CameraTarget>;

/** Owns viewers only. Releasing a viewer never stops a resident camera source. */
export class PlaybackManager {
  private readonly entries = new Map<string, Reservation | Playback>();
  private readonly releases = new Map<
    string,
    { target: CameraTarget; pending?: Promise<void> }
  >();

  constructor(private readonly prepareCamera: PrepareCamera) {}

  reserve(revision: string, deviceId: string, channel: 1 | 2) {
    if (this.entries.size + this.releases.size >= 32)
      throw new MijiaError("playback_failed");
    const id = crypto.randomUUID();
    const timer = context.with(ROOT_CONTEXT, () =>
      setTimeout(() => this.entries.delete(id), 30_000),
    );
    timer.unref();
    this.entries.set(id, {
      phase: "reserved",
      id,
      revision,
      deviceId,
      channel,
      timer,
    });
    return { id };
  }

  activeIds(adapter: Go2RtcAdapter) {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.phase === "active" && entry.target?.adapter === adapter,
      )
      .map((entry) => entry.id);
  }

  /** IDs were captured before the heartbeat, so it cannot retire a newer offer. */
  forgetEnded(adapter: Go2RtcAdapter, ids: readonly string[]) {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry?.phase === "active" && entry.target?.adapter === adapter) {
        this.entries.delete(id);
        entry.controller.abort();
      }
    }
  }

  /** A confirmed session deletion also retires its outstanding viewer cleanup. */
  forgetAdapter(adapter: Go2RtcAdapter) {
    for (const [id, release] of this.releases) {
      if (release.target.adapter === adapter) this.releases.delete(id);
    }
  }

  /** A successful heartbeat supplies the next opportunity to retry revoked viewers. */
  retryReleases(adapter: Go2RtcAdapter) {
    for (const [id, release] of this.releases) {
      if (release.target.adapter === adapter)
        void this.release(id).catch(() => {});
    }
  }

  invalidate() {
    for (const id of this.entries.keys()) {
      void this.release(id).catch(() => {});
    }
  }

  releaseForSource(adapter: Go2RtcAdapter, sourceId: string) {
    for (const entry of this.entries.values()) {
      if (
        entry.phase !== "reserved" &&
        entry.target?.adapter === adapter &&
        entry.target.sourceId === sourceId
      )
        void this.release(entry.id).catch(() => {});
    }
  }

  snapshot(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new AppError("not_found");
    if (entry.phase === "active") {
      if (!entry.answer) throw new MijiaError("internal_error");
      return { id, phase: entry.phase, answer: entry.answer };
    }
    return { id, phase: entry.phase };
  }

  async offer(revision: string, id: string, sdp: string, signal: AbortSignal) {
    if (signal.aborted) throw new MijiaError("cancelled");
    const entry = this.entries.get(id);
    if (!entry || entry.revision !== revision)
      throw new MijiaError("stale_session");
    const offerFingerprint = createHash("sha256").update(sdp).digest("hex");
    if (entry.phase !== "reserved") {
      if (entry.offerFingerprint !== offerFingerprint)
        throw new MijiaError("playback_conflict");
      return entry.result;
    }
    clearTimeout(entry.timer);
    const playback: Playback = {
      phase: "negotiating",
      id,
      revision,
      offerFingerprint,
      controller: new AbortController(),
      result: Promise.resolve().then(() =>
        this.negotiate(entry, playback, sdp),
      ),
    };
    this.entries.set(id, playback);
    // A transport disconnect does not cancel an accepted PUT. DELETE and this
    // bounded deadline own cancellation, allowing another request to recover it.
    playback.timer = context.with(ROOT_CONTEXT, () =>
      setTimeout(() => {
        void this.release(id).catch(() => {});
      }, mijiaTimeouts.playback),
    );
    playback.timer.unref();
    return playback.result;
  }

  private async negotiate(
    reservation: Reservation,
    playback: Playback,
    sdp: string,
  ) {
    const { id, controller } = playback;
    const assertActive = () => {
      if (controller.signal.aborted) throw new MijiaError("cancelled");
      if (this.entries.get(id) !== playback)
        throw new MijiaError("stale_session");
    };
    try {
      return await mijiaOperation(
        "playback.offer",
        "playback_failed",
        async () => {
          assertActive();
          const target = await this.prepareCamera(
            reservation.revision,
            reservation.deviceId,
            reservation.channel,
            controller.signal,
          );
          assertActive();
          playback.target = target;
          const answer = await target.adapter.offer(
            { id, sourceId: target.sourceId },
            sdp,
            controller.signal,
          );
          assertActive();
          playback.answer = answer;
          playback.phase = "active";
          return answer;
        },
      );
    } catch (error) {
      if (this.entries.get(id) === playback)
        void this.release(id).catch(() => {});
      throw error;
    } finally {
      clearTimeout(playback.timer);
    }
  }

  async release(id: string) {
    const entry = this.entries.get(id);
    if (entry) {
      // Revoke access immediately, but retain remote ownership until DELETE succeeds.
      this.entries.delete(id);
      clearTimeout(entry.timer);
      if (entry.phase !== "reserved") {
        if (entry.target) this.releases.set(id, { target: entry.target });
        entry.controller.abort();
      }
    }
    const release = this.releases.get(id);
    if (!release) return;
    if (!release.pending) {
      const { adapter, sourceId } = release.target;
      release.pending = Promise.resolve()
        .then(() =>
          mijiaOperation("playback.release", "playback_failed", () =>
            adapter.release({ id, sourceId }),
          ),
        )
        .then(() => {
          if (this.releases.get(id) === release) this.releases.delete(id);
        })
        .finally(() => {
          delete release.pending;
        });
    }
    await release.pending;
  }
}
