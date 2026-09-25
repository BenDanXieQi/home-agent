import type { MiCloudDevice } from "./micloud";
import { context, ROOT_CONTEXT } from "@home-agent/observability";
import type { Go2RtcAdapter } from "./go2rtc-adapter";
import { isRecoverableMijiaError, MijiaError, safeMijiaError } from "./errors";
import type { PlaybackManager } from "./playback-manager";
import { RetryTimer } from "./retry-timer";

import type { CameraSourceSpec } from "./camera-source";
import { isCamera, cameraChannels } from "./devices";
type CameraSourceEntry = {
  id: string;
  device: CameraSourceSpec;
  pending: Promise<void>;
  prepared: boolean;
  retiring: boolean;
  retry: RetryTimer;
  error?: MijiaError;
};

const OFFLINE_GRACE_MS = 60_000;

/** Owns shared sources; a cloud-offline report has a bounded grace period only for prepared sources. */
export class CameraSourceManager {
  private readonly streams = new Map<string, CameraSourceEntry>();
  private readonly offlineUntil = new Map<string, number>();
  private offlineTimer: ReturnType<typeof setTimeout> | undefined;
  private devices = new Map<string, MiCloudDevice>();
  private closed = false;
  private paused = false;

  constructor(
    private readonly adapter: Go2RtcAdapter,
    private readonly playback: PlaybackManager,
    private readonly onCleanupFailed: (error: unknown) => void,
  ) {}

  update(devices: readonly MiCloudDevice[], retryFailed = false) {
    if (this.closed) return Promise.resolve();
    this.devices = new Map(devices.map((device) => [device.did, device]));
    for (const id of this.offlineUntil.keys()) {
      if (!this.devices.has(id)) this.offlineUntil.delete(id);
    }
    for (const device of devices) {
      if (device.isOnline || !isCamera(device)) {
        this.offlineUntil.delete(device.did);
      } else if (
        !this.offlineUntil.has(device.did) &&
        cameraChannels(device).some((channel) =>
          this.preparedSource(device, channel),
        )
      ) {
        this.offlineUntil.set(device.did, performance.now() + OFFLINE_GRACE_MS);
      }
    }
    this.scheduleOfflineExpiry();
    return this.reconcile(retryFailed);
  }

  /** Cloud state stays unchanged; these existing channels remain usable during confirmation. */
  retainedChannels(deviceId: string) {
    const device = this.devices.get(deviceId);
    const until = this.offlineUntil.get(deviceId);
    if (
      this.closed ||
      !device ||
      device.isOnline ||
      until === undefined ||
      performance.now() >= until
    )
      return [];
    return cameraChannels(device).filter((channel) =>
      this.preparedSource(device, channel),
    );
  }

  private preparedSource(device: MiCloudDevice, channel: 1 | 2) {
    const stream = this.streams.get(`${device.did}:${channel}`);
    return (
      stream?.prepared === true &&
      !stream.retiring &&
      !stream.error &&
      stream.device.model === device.model &&
      stream.device.localIp === device.localip
    );
  }

  private scheduleOfflineExpiry() {
    clearTimeout(this.offlineTimer);
    this.offlineTimer = undefined;
    if (this.closed || this.paused) return;
    const now = performance.now();
    const deadlines = [...this.offlineUntil.values()].filter(
      (until) => until > now,
    );
    if (!deadlines.length) return;
    this.offlineTimer = context.with(ROOT_CONTEXT, () =>
      setTimeout(
        () => {
          this.offlineTimer = undefined;
          void this.reconcile();
          this.scheduleOfflineExpiry();
        },
        Math.ceil(Math.min(...deadlines) - now),
      ),
    );
    this.offlineTimer.unref();
  }

  pause() {
    this.paused = true;
    clearTimeout(this.offlineTimer);
    this.offlineTimer = undefined;
    for (const stream of this.streams.values()) stream.retry.cancel();
  }

  resume() {
    if (this.closed) return;
    this.paused = false;
    this.scheduleOfflineExpiry();
    for (const [key, stream] of this.streams) {
      if (stream.error && isRecoverableMijiaError(stream.error))
        stream.retry.schedule(() => this.retry(key, stream));
    }
    void this.reconcile();
  }

  /** Fence local work; the session owner closes the adapter and its remote streams. */
  dispose() {
    this.closed = true;
    this.pause();
    this.streams.clear();
    this.devices.clear();
    this.offlineUntil.clear();
  }

  validate(deviceId: string, channel: 1 | 2) {
    if (this.closed) throw new MijiaError("stale_session");
    const device = this.devices.get(deviceId);
    if (
      !device ||
      !isCamera(device) ||
      !cameraChannels(device).includes(channel)
    )
      throw new MijiaError("camera_invalid");
    if (!device.isOnline && !this.retainedChannels(deviceId).includes(channel))
      throw new MijiaError("camera_offline");
    return {
      deviceId,
      channel,
      model: device.model!,
      ...(typeof device.localip === "string"
        ? { localIp: device.localip }
        : {}),
    } satisfies CameraSourceSpec;
  }

  async prepare(deviceId: string, channel: 1 | 2) {
    if (this.paused) throw new MijiaError("cancelled");
    const sourceId = await this.ensure(deviceId, channel, true);
    return { adapter: this.adapter, sourceId };
  }

  private async ensure(deviceId: string, channel: 1 | 2, retryFailed = false) {
    const device = this.validate(deviceId, channel);
    const key = `${deviceId}:${channel}`;
    let stream = this.streams.get(key);
    if (
      !stream ||
      stream.retiring ||
      stream.device.model !== device.model ||
      stream.device.localIp !== device.localIp
    ) {
      const removed = stream ? this.retire(key, stream) : Promise.resolve();
      const next: CameraSourceEntry = {
        id: crypto.randomUUID(),
        device,
        pending: Promise.resolve(),
        prepared: false,
        retiring: false,
        retry: new RetryTimer(),
      };
      this.streams.set(key, next);
      next.pending = this.prepareStream(key, next, removed);
      stream = next;
    } else if (stream.error && retryFailed) {
      stream.retry.cancel();
      this.retry(key, stream);
    }
    await stream.pending;
    if (!this.current(key, stream)) throw new MijiaError("stale_session");
    if (stream.error) throw stream.error;
    return stream.id;
  }

  private current(key: string, stream: CameraSourceEntry) {
    return !this.closed && this.streams.get(key) === stream && !stream.retiring;
  }

  private retry(key: string, stream: CameraSourceEntry) {
    if (this.paused || !this.current(key, stream)) return;
    // DELETE retires the previous ID even when the failed PUT response was lost.
    stream.id = crypto.randomUUID();
    stream.prepared = false;
    delete stream.error;
    stream.pending = this.prepareStream(key, stream);
  }

  private async prepareStream(
    key: string,
    stream: CameraSourceEntry,
    removed = Promise.resolve(),
  ) {
    try {
      await removed;
      if (!this.current(key, stream)) return;
      try {
        await this.adapter.prepareCamera(stream.id, stream.device);
      } catch (error) {
        await this.remove(stream.id);
        throw error;
      }
      if (this.current(key, stream)) {
        stream.prepared = true;
        stream.retry.cancel();
      }
    } catch (error) {
      if (!this.current(key, stream)) return;
      stream.error = safeMijiaError(error, "camera_failed");
      console.warn(
        JSON.stringify({
          message: "Camera source preparation failed",
          code: stream.error.code,
        }),
      );
      if (!this.paused && isRecoverableMijiaError(error)) {
        stream.retry.schedule(() => this.retry(key, stream));
      } else {
        stream.retry.cancel();
      }
    }
  }

  private async remove(id: string) {
    try {
      await this.adapter.removeCamera(id);
    } catch (error) {
      if (!this.closed) this.onCleanupFailed(error);
      throw safeMijiaError(error, "go2rtc_cleanup");
    }
  }

  private retire(key: string, stream: CameraSourceEntry) {
    if (stream.retiring) return stream.pending;
    stream.retiring = true;
    stream.retry.cancel();
    this.playback.releaseForSource(this.adapter, stream.id);
    const prepared = stream.pending;
    stream.pending = (async () => {
      await prepared.catch(() => {});
      if (!stream.error) await this.remove(stream.id);
      if (this.streams.get(key) === stream) this.streams.delete(key);
    })();
    return stream.pending;
  }

  private async reconcile(retryFailed = false) {
    if (this.closed || this.paused) return;
    const desired = new Set<string>();
    const pending: Promise<unknown>[] = [];
    for (const device of this.devices.values()) {
      const channels = device.isOnline
        ? cameraChannels(device)
        : this.retainedChannels(device.did);
      for (const channel of channels) {
        desired.add(`${device.did}:${channel}`);
        pending.push(this.ensure(device.did, channel, retryFailed));
      }
    }
    for (const [key, stream] of this.streams) {
      if (!desired.has(key)) pending.push(this.retire(key, stream));
    }
    // Failures are owned and reported by each source, without stopping its peers.
    await Promise.allSettled(pending);
  }
}
