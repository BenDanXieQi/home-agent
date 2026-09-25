import type { CameraSourceSpec } from "./camera-source-spec";
import { mijiaTimeouts } from "@home-agent/api/mijia";
import type { MiCloudCredentials } from "../protocols/micloud";
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  recordFailure,
  withSpan,
} from "@home-agent/observability";
import { z } from "zod";
import {
  readLimitedJson,
  ResponseBodyError,
} from "@home-agent/api/http/read-body";

const responseSchema = z.object({
  playbackId: z.uuid(),
  answer: z
    .string()
    .min(1)
    .max(96 * 1024),
});
const heartbeatSchema = z.object({ playbackIds: z.array(z.uuid()).max(32) });
const HEARTBEAT_INTERVAL_MS = 15_000;
const SESSION_LEASE_MS = 60_000;
const errorCodeSchema = z.enum([
  "invalid_request",
  "local_access_required",
  "invalid_credentials",
  "credentials_rejected",
  "go2rtc_unavailable",
  "request_timeout",
  "session_expired",
  "camera_unavailable",
  "camera_not_found",
  "invalid_offer",
  "stale_playback",
  "unsupported_codec",
  "camera_connection_failed",
  "signaling_failed",
  "webrtc_unavailable",
]);

export type Go2RtcErrorCode =
  | z.infer<typeof errorCodeSchema>
  | "adapter_unavailable"
  | "invalid_response"
  | "request_cancelled";

export class Go2RtcError extends Error {
  constructor(readonly code: Go2RtcErrorCode) {
    super(code);
    this.name = "Go2RtcError";
  }
}

const go2rtcSpanOptions = {
  onError: (span, error) => {
    const failure =
      error instanceof Go2RtcError
        ? error
        : new Go2RtcError("go2rtc_unavailable");
    if (failure.code === "request_cancelled") {
      span.setAttribute("operation.cancelled", true);
      return;
    }
    recordFailure(span, failure, failure.code);
  },
} satisfies NonNullable<Parameters<typeof withSpan>[3]>;

type PlaybackOwner = { id: string; sourceId: string };
type AdapterEvents = {
  onLost: (error: Go2RtcError) => void;
  activePlaybackIds: () => readonly string[];
  onPlaybackEnded: (ids: readonly string[]) => void;
};

/** One backend-owned, memory-only session on one configured go2rtc instance. */
export class Go2RtcAdapter {
  private sessionId: string | undefined;
  private ready = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private leaseUntil = 0;
  private heartbeatFailure: Go2RtcError | undefined;
  private heartbeatController: AbortController | undefined;
  private heartbeatPending:
    | { sessionId: string; promise: Promise<void> }
    | undefined;

  constructor(
    readonly url: string,
    private readonly events: AdapterEvents,
  ) {}

  /** Startup recovery: remove only the adapter's private residual state. */
  async reset() {
    this.stopHeartbeat();
    this.ready = false;
    const sessionId = this.sessionId;
    await this.request("session", "DELETE", { reset: true });
    if (this.sessionId === sessionId) this.sessionId = undefined;
  }

  async install(credentials: MiCloudCredentials, signal?: AbortSignal) {
    this.stopHeartbeat();
    this.ready = false;
    const sessionId = crypto.randomUUID();
    // The ID is retained on failure so a partial installation can be fenced off
    // by close(). The remote API clears the previous session before authenticating.
    this.sessionId = sessionId;
    const controller = new AbortController();
    this.heartbeatController = controller;
    const installSignal = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    const sentAt = performance.now();
    await this.request(
      "session",
      "PUT",
      { sessionId, ...credentials },
      mijiaTimeouts.install,
      installSignal,
    );
    if (this.sessionId !== sessionId || installSignal.aborted)
      throw new Go2RtcError("request_cancelled");
    if (performance.now() >= sentAt + SESSION_LEASE_MS)
      throw new Go2RtcError("request_timeout");
    this.ready = true;
    this.renewLease(sessionId, sentAt);
    if (!this.ready) throw new Go2RtcError("request_timeout");
    this.heartbeatTimer = context.with(ROOT_CONTEXT, () =>
      setInterval(() => {
        void this.renewSessionLease().catch(() => {});
      }, HEARTBEAT_INTERVAL_MS),
    );
    this.heartbeatTimer.unref();
    // Token installation can consume most of the conservative initial lease.
    void this.renewSessionLease().catch(() => {});
  }

  async prepareCamera(
    sourceId: string,
    camera: CameraSourceSpec,
    signal?: AbortSignal,
  ) {
    const sessionId = this.requireSession();
    await this.request(
      "camera",
      "PUT",
      {
        sessionId,
        sourceId,
        did: camera.deviceId,
        channel: camera.channel,
        channelCount: camera.channelCount,
        model: camera.model,
        localip: camera.localIp,
      },
      mijiaTimeouts.upstream,
      signal,
    );
  }

  async removeCamera(sourceId: string) {
    await this.request("camera", "DELETE", {
      sessionId: this.requireSession(),
      sourceId,
    });
  }

  async offer(owner: PlaybackOwner, sdp: string, signal?: AbortSignal) {
    const sessionId = this.requireSession();
    const payload = await this.request(
      "playback",
      "POST",
      {
        sessionId,
        sourceId: owner.sourceId,
        playbackId: owner.id,
        offer: sdp,
      },
      mijiaTimeouts.signaling,
      signal,
    );
    const result = responseSchema.safeParse(payload);
    if (!result.success || result.data.playbackId !== owner.id)
      throw new Go2RtcError("invalid_response");
    return { id: result.data.playbackId, sdp: result.data.answer };
  }

  async release(owner: PlaybackOwner) {
    if (!this.sessionId) return;
    try {
      await this.request("playback", "DELETE", {
        sessionId: this.sessionId,
        sourceId: owner.sourceId,
        playbackId: owner.id,
      });
    } catch (error) {
      if (error instanceof Go2RtcError && error.code === "session_expired")
        return;
      throw error;
    }
  }

  /** Verifies instance ownership and renews the 60-second remote lease. */
  async renewSessionLease(signal?: AbortSignal) {
    if (signal?.aborted) throw new Go2RtcError("request_cancelled");
    const sessionId = this.requireSession();
    let pending = this.heartbeatPending;
    if (!pending || pending.sessionId !== sessionId) {
      pending = {
        sessionId,
        promise: this.probeSession(sessionId, this.heartbeatController!),
      };
      this.heartbeatPending = pending;
      const current = pending;
      void pending.promise
        .finally(() => {
          if (this.heartbeatPending === current)
            this.heartbeatPending = undefined;
        })
        .catch(() => {});
    }
    const promise = pending.promise;
    if (!signal) return promise;
    // A viewer owns only its wait, not the shared session's renewal request.
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Go2RtcError("request_cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      void promise
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private probeSession(sessionId: string, controller: AbortController) {
    return withSpan(
      "mijia.go2rtc.heartbeat.check",
      {},
      async () => {
        const sentAt = performance.now();
        // Only compare viewers established before this request. A response may
        // arrive after an unrelated offer has just completed.
        const trackedIds = this.events.activePlaybackIds();
        try {
          const payload = await this.request(
            "heartbeat",
            "POST",
            { sessionId },
            mijiaTimeouts.upstream,
            controller.signal,
          );
          const parsed = heartbeatSchema.safeParse(payload);
          if (!parsed.success) throw new Go2RtcError("invalid_response");
          if (this.sessionId === sessionId && this.ready) {
            if (performance.now() >= this.leaseUntil)
              throw this.heartbeatFailure ?? new Go2RtcError("request_timeout");
            this.renewLease(sessionId, sentAt);
            const liveIds = new Set(parsed.data.playbackIds);
            this.events.onPlaybackEnded(
              trackedIds.filter((id) => !liveIds.has(id)),
            );
          }
        } catch (error) {
          const failure =
            error instanceof Go2RtcError
              ? error
              : new Go2RtcError("go2rtc_unavailable");
          if (
            !controller.signal.aborted &&
            this.sessionId === sessionId &&
            this.ready
          ) {
            this.heartbeatFailure = failure;
            if (
              (failure.code !== "go2rtc_unavailable" &&
                failure.code !== "request_timeout") ||
              performance.now() >= this.leaseUntil
            )
              this.loseSession(sessionId, failure);
          }
          throw failure;
        }
      },
      go2rtcSpanOptions,
    );
  }

  /** Stop media, delete the private stream and invalidate its account cache. */
  async close() {
    this.stopHeartbeat();
    this.ready = false;
    const sessionId = this.sessionId;
    if (!sessionId) return;
    try {
      await this.request("session", "DELETE", { sessionId });
    } catch (error) {
      if (!(error instanceof Go2RtcError && error.code === "session_expired"))
        throw error;
    }
    if (this.sessionId === sessionId) this.sessionId = undefined;
  }

  private requireSession() {
    if (this.ready && this.sessionId && performance.now() >= this.leaseUntil)
      this.loseSession(
        this.sessionId,
        this.heartbeatFailure ?? new Go2RtcError("request_timeout"),
      );
    if (!this.ready || !this.sessionId)
      throw new Go2RtcError("session_expired");
    return this.sessionId;
  }

  private stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.leaseTimer);
    this.heartbeatTimer = undefined;
    this.leaseTimer = undefined;
    this.heartbeatController?.abort();
    this.heartbeatController = undefined;
    this.heartbeatPending = undefined;
    this.leaseUntil = 0;
    this.heartbeatFailure = undefined;
  }

  private renewLease(sessionId: string, sentAt: number) {
    // The server renewed after this request began. Response arrival would
    // overestimate the remaining lease when transport or body reads are slow.
    this.leaseUntil = sentAt + SESSION_LEASE_MS;
    this.heartbeatFailure = undefined;
    this.scheduleLeaseExpiry(sessionId);
  }

  private scheduleLeaseExpiry(sessionId: string) {
    if (this.sessionId !== sessionId || !this.ready) return;
    clearTimeout(this.leaseTimer);
    const remaining = Math.ceil(this.leaseUntil - performance.now());
    if (remaining <= 0) {
      this.loseSession(
        sessionId,
        this.heartbeatFailure ?? new Go2RtcError("request_timeout"),
      );
      return;
    }
    this.leaseTimer = context.with(ROOT_CONTEXT, () =>
      setTimeout(() => this.scheduleLeaseExpiry(sessionId), remaining),
    );
    this.leaseTimer.unref();
  }

  private loseSession(sessionId: string, error: Go2RtcError) {
    if (this.sessionId !== sessionId || !this.ready) return;
    this.ready = false;
    this.stopHeartbeat();
    this.events.onLost(error);
  }

  private request(
    action: "session" | "camera" | "playback" | "heartbeat",
    method: "PUT" | "POST" | "DELETE",
    body: object,
    timeoutMs: number = mijiaTimeouts.upstream,
    callerSignal?: AbortSignal,
  ) {
    // Only static operation metadata is traced. Raw transport failures, request
    // bodies, response bodies, credentials and SDP never reach tracing/logging.
    return withSpan(
      `mijia.go2rtc.${action}`,
      { "http.request.method": method },
      async (span) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const completion = new AbortController();
        const signal = AbortSignal.any([
          timeout,
          completion.signal,
          ...(callerSignal ? [callerSignal] : []),
        ]);
        try {
          const response = await fetch(
            new URL(`/api/home-agent/mijia/${action}`, this.url),
            {
              method,
              redirect: "error",
              signal,
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "X-Home-Agent": "mijia",
              },
              body: JSON.stringify(body),
            },
          );
          span.setAttribute("http.response.status_code", response.status);
          if (response.status === 204) return undefined;
          if (response.status === 404)
            throw new Go2RtcError("adapter_unavailable");
          if (
            !/^application\/json(?:\s*;|$)/i.test(
              response.headers.get("content-type") ?? "",
            )
          )
            throw new Go2RtcError("invalid_response");
          const payload = await readLimitedJson(response, 128 * 1024);
          if (!response.ok) {
            const parsed = z
              .object({ code: errorCodeSchema })
              .safeParse(payload);
            throw new Go2RtcError(
              parsed.success ? parsed.data.code : "invalid_response",
            );
          }
          return payload;
        } catch (error) {
          if (error instanceof Go2RtcError) throw error;
          if (error instanceof ResponseBodyError)
            throw new Go2RtcError("invalid_response");
          if (signal.aborted)
            throw new Go2RtcError(
              signal.reason instanceof DOMException &&
                signal.reason.name === "TimeoutError"
                ? "request_timeout"
                : "request_cancelled",
            );
          throw new Go2RtcError("go2rtc_unavailable");
        } finally {
          completion.abort();
        }
      },
      {
        ...go2rtcSpanOptions,
        kind: SpanKind.CLIENT,
      },
    );
  }
}
