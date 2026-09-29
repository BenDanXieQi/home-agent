import { createHash } from "node:crypto";
import { AppError } from "@home-agent/api/errors";
import {
  mijiaTimeouts,
  type MijiaPlaybackResponse,
} from "@home-agent/api/mijia";
import {
  context,
  currentTraceId,
  ROOT_CONTEXT,
} from "@home-agent/observability";
import type { Go2RtcAdapter } from "./go2rtc-adapter";
import type { CameraSourceManager } from "./camera-source-manager";
import type { CameraSourceSpec } from "./camera-source-spec";
import { MijiaError } from "../errors";
import { mijiaOperation } from "../operation";

type CameraTarget = Awaited<ReturnType<CameraSourceManager["prepare"]>>;
type Viewer = Pick<CameraSourceSpec, "deviceId" | "channel"> & {
  id: string;
  revision: string;
  reservedAt: number;
  timer: ReturnType<typeof setTimeout>;
};
type Reservation = Viewer & { phase: "reserved" };
type AcceptedOffer = Viewer & {
  offeredAt: number;
  offerFingerprint: string;
  result: Promise<MijiaPlaybackResponse>;
  controller: AbortController;
};
type Negotiating = AcceptedOffer & {
  phase: "negotiating";
  target?: CameraTarget;
};
type Active = AcceptedOffer & {
  phase: "active";
  target: CameraTarget;
  answer: MijiaPlaybackResponse;
};
type Playback = Reservation | Negotiating | Active;
type PrepareCamera = (
  revision: string,
  deviceId: string,
  channel: CameraSourceSpec["channel"],
  signal: AbortSignal,
) => Promise<CameraTarget>;

/** Owns viewers only. Releasing a viewer never stops a resident camera source. */
export class PlaybackManager {
  private readonly entries = new Map<string, Playback>();
  private readonly releases = new Map<
    string,
    { target: CameraTarget; pending?: Promise<void> }
  >();

  constructor(private readonly prepareCamera: PrepareCamera) {}

  reserve(
    revision: string,
    deviceId: string,
    channel: CameraSourceSpec["channel"],
  ) {
    if (this.entries.size + this.releases.size >= 32)
      throw new MijiaError("playback_failed");
    const id = crypto.randomUUID();
    const timer = context.with(ROOT_CONTEXT, () =>
      setTimeout(() => {
        this.release(id).catch(() => {});
      }, 30_000),
    );
    timer.unref();
    this.entries.set(id, {
      phase: "reserved",
      id,
      revision,
      deviceId,
      channel,
      reservedAt: performance.now(),
      timer,
    });
    return { id };
  }

  activeIds(adapter: Go2RtcAdapter) {
    return [...this.entries.values()]
      .filter(
        (entry) => entry.phase === "active" && entry.target.adapter === adapter,
      )
      .map((entry) => entry.id);
  }

  /** IDs were captured before the heartbeat, so it cannot retire a newer offer. */
  forgetEnded(adapter: Go2RtcAdapter, ids: readonly string[]) {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry?.phase === "active" && entry.target.adapter === adapter) {
        this.entries.delete(id);
        entry.controller.abort();
        this.log(entry, "Camera playback ended remotely");
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
      if (release.target.adapter === adapter) this.release(id).catch(() => {});
    }
  }

  invalidate() {
    for (const id of this.entries.keys()) {
      this.release(id).catch(() => {});
    }
  }

  releaseForDevices(ids: readonly string[]) {
    const revoked = new Set(ids);
    for (const entry of this.entries.values())
      if (revoked.has(entry.deviceId)) this.release(entry.id).catch(() => {});
  }

  releaseForSource(adapter: Go2RtcAdapter, sourceId: string) {
    for (const entry of this.entries.values()) {
      if (
        entry.phase !== "reserved" &&
        entry.target?.adapter === adapter &&
        entry.target.sourceId === sourceId
      )
        this.release(entry.id).catch(() => {});
    }
  }

  snapshot(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new AppError("not_found");
    if (entry.phase === "active")
      return { id, phase: entry.phase, answer: entry.answer };
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
    // DELETE and this deadline own cancellation. A transport disconnect permits
    // another request to recover the accepted offer with the same SDP.
    const timer = context.with(ROOT_CONTEXT, () =>
      setTimeout(() => {
        this.release(id).catch(() => {});
      }, mijiaTimeouts.playback),
    );
    timer.unref();
    const playback: Negotiating = {
      ...entry,
      phase: "negotiating",
      offerFingerprint,
      offeredAt: performance.now(),
      controller: new AbortController(),
      timer,
      result: Promise.resolve().then(() => this.negotiate(playback, sdp)),
    };
    this.entries.set(id, playback);
    return playback.result;
  }

  private async negotiate(playback: Negotiating, sdp: string) {
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
            playback.revision,
            playback.deviceId,
            playback.channel,
            controller.signal,
          );
          assertActive();
          playback.target = target;
          const prepareMs = performance.now() - playback.offeredAt;
          const result = await target.adapter.offer(
            { id, sourceId: target.sourceId },
            sdp,
            controller.signal,
          );
          assertActive();
          const answer = {
            id: result.id,
            sdp: result.sdp,
            connection: {
              sourceRecentlyActive:
                result.observation?.sourceRecentlyActive ?? null,
              timings: {
                ...result.observation?.timings,
                prepareMs,
                negotiationMs: performance.now() - playback.offeredAt,
              },
            },
          };
          const active: Active = {
            ...playback,
            phase: "active",
            target,
            answer,
          };
          this.entries.set(id, active);
          this.log(active, "Camera playback negotiated");
          return answer;
        },
      );
    } catch (error) {
      if (this.entries.get(id) === playback) this.release(id).catch(() => {});
      throw error;
    } finally {
      clearTimeout(playback.timer);
    }
  }

  async release(id: string) {
    const entry = this.entries.get(id);
    if (entry) {
      // Revoke access immediately, retaining remote ownership until DELETE succeeds.
      this.entries.delete(id);
      clearTimeout(entry.timer);
      if (entry.phase !== "reserved") {
        if (entry.target) this.releases.set(id, { target: entry.target });
        entry.controller.abort();
      }
      this.log(entry, "Camera playback released");
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

  private log(entry: Playback, message: string) {
    console.info(
      JSON.stringify({
        message,
        attempt_id: createHash("sha256")
          .update(entry.id)
          .digest("hex")
          .slice(0, 16),
        trace_id: currentTraceId(),
        phase: entry.phase,
        serverElapsedMs: Math.max(0, performance.now() - entry.reservedAt),
        ...(entry.phase === "active"
          ? { connection: entry.answer.connection }
          : {}),
      }),
    );
  }
}
