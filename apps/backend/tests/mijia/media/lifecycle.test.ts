import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { PlaybackManager } from "../../../src/mijia/media/playback-manager";
import { CameraSourceManager } from "../../../src/mijia/media/camera-source-manager";
import { MediaSession } from "../../../src/mijia/media/session";
import { accountClient } from "../../support/protocol-fixtures";
import { deferred, nextTurn } from "../../support/async";
import { camera, mediaPeer, sourceId } from "./support";

const peers: ReturnType<typeof mediaPeer>[] = [];
const playbacks: PlaybackManager[] = [];
const sources: CameraSourceManager[] = [];
const sessions: MediaSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  for (const owner of sources.splice(0)) owner.dispose();
  for (const owner of playbacks.splice(0)) owner.invalidate();
  await Promise.all(peers.splice(0).map((peer) => peer.close()));
  jest.useRealTimers();
});

async function setup() {
  const peer = mediaPeer();
  peers.push(peer);
  await peer.install();
  const playback = new PlaybackManager(async () => ({
    adapter: peer.adapter,
    sourceId,
  }));
  playbacks.push(playback);
  return { ...peer, playback };
}

const signal = () => new AbortController().signal;

describe("independent viewers and bounded cleanup", () => {
  test("unoffered reservation expires after 30 seconds without touching media", async () => {
    jest.useFakeTimers();
    const prepare = mock(async () => {
      throw new Error("reservation must remain local");
    });
    const playback = new PlaybackManager(prepare);
    playbacks.push(playback);
    const { id } = playback.reserve("revision", camera.did, 1);
    jest.advanceTimersByTime(29_999);
    expect(playback.snapshot(id).phase).toBe("reserved");
    jest.advanceTimersByTime(1);
    expect(() => playback.snapshot(id)).toThrow();
    await expect(
      playback.offer("revision", id, "late-offer", signal()),
    ).rejects.toMatchObject({ reason: "stale_session" });
    expect(prepare).not.toHaveBeenCalled();
  });
  test("reservation is local, same SDP is idempotent, conflicting SDP and stale revisions are rejected", async () => {
    const { playback, calls } = await setup();
    const { id } = playback.reserve("revision", camera.did, 1);
    expect(calls.filter((call) => call.path === "playback")).toHaveLength(0);
    expect(playback.snapshot(id)).toEqual({ id, phase: "reserved" });
    await expect(
      playback.offer("old-revision", id, "offer", signal()),
    ).rejects.toMatchObject({ reason: "stale_session" });
    const [first, repeated] = await Promise.all([
      playback.offer("revision", id, "offer", signal()),
      playback.offer("revision", id, "offer", signal()),
    ]);
    expect(first).toEqual(repeated);
    expect(
      calls.filter(
        (call) => call.path === "playback" && call.method === "POST",
      ),
    ).toHaveLength(1);
    await expect(
      playback.offer("revision", id, "different-offer", signal()),
    ).rejects.toMatchObject({ reason: "playback_conflict" });
  });

  test("releasing one viewer immediately revokes it; failed DELETE remains retryable without stopping its peer or source", async () => {
    const { playback, adapter, handlers, calls } = await setup();
    const first = playback.reserve("revision", camera.did, 1);
    const second = playback.reserve("revision", camera.did, 1);
    await playback.offer("revision", first.id, "offer-1", signal());
    await playback.offer("revision", second.id, "offer-2", signal());
    handlers.set("DELETE playback", () =>
      Response.json({ code: "go2rtc_unavailable" }, { status: 503 }),
    );
    const releasing = playback.release(first.id);
    expect(() => playback.snapshot(first.id)).toThrow();
    expect(playback.snapshot(second.id).phase).toBe("active");
    await expect(releasing).rejects.toMatchObject({
      reason: "go2rtc_unavailable",
    });
    handlers.delete("DELETE playback");
    await Promise.all([playback.release(first.id), playback.release(first.id)]);
    expect(
      calls.filter(
        (call) =>
          call.method === "DELETE" &&
          call.path === "playback" &&
          call.body.playbackId === first.id,
      ),
    ).toHaveLength(2);
    expect(
      calls.filter(
        (call) => call.method === "DELETE" && call.path === "camera",
      ),
    ).toHaveLength(0);
    expect(playback.activeIds(adapter)).toEqual([second.id]);
  });

  test("failed cleanup consumes capacity until confirmed deletion, even though local viewer is gone", async () => {
    const { playback, handlers } = await setup();
    const active = playback.reserve("revision", camera.did, 1);
    await playback.offer("revision", active.id, "offer", signal());
    handlers.set("DELETE playback", () =>
      Response.json({ code: "go2rtc_unavailable" }, { status: 503 }),
    );
    await expect(playback.release(active.id)).rejects.toThrow();
    for (let count = 0; count < 31; count++)
      playback.reserve("revision", camera.did, 1);
    expect(() => playback.reserve("revision", camera.did, 1)).toThrow();
    handlers.delete("DELETE playback");
    await playback.release(active.id);
    expect(playback.reserve("revision", camera.did, 1).id).toBeString();
  });

  test("DELETE during slow SDP negotiation prevents a late answer from restoring access", async () => {
    const { playback, handlers, calls } = await setup();
    const entered = deferred();
    const response = deferred<Response>();
    handlers.set("POST playback", () => {
      entered.resolve();
      return response.promise;
    });
    const { id } = playback.reserve("revision", camera.did, 1);
    const outcome = playback.offer("revision", id, "offer", signal()).then(
      () => "accepted",
      () => "cancelled",
    );
    await entered.promise;
    await playback.release(id);
    response.resolve(Response.json({ playbackId: id, answer: "late-answer" }));
    expect(await outcome).toBe("cancelled");
    expect(() => playback.snapshot(id)).toThrow();
    expect(
      calls.some(
        (call) => call.method === "DELETE" && call.body.playbackId === id,
      ),
    ).toBe(true);
  });

  test("accepted negotiation survives caller transport disconnect and can be recovered by retry", async () => {
    const { playback, handlers } = await setup();
    const entered = deferred();
    const response = deferred<Response>();
    handlers.set("POST playback", () => {
      entered.resolve();
      return response.promise;
    });
    const caller = new AbortController();
    const { id } = playback.reserve("revision", camera.did, 1);
    const offer = playback.offer("revision", id, "offer", caller.signal);
    await entered.promise;
    caller.abort();
    response.resolve(Response.json({ playbackId: id, answer: "answer" }));
    expect(await offer).toEqual({ id, sdp: "answer" });
    expect(await playback.offer("revision", id, "offer", signal())).toEqual({
      id,
      sdp: "answer",
    });
  });
});

describe("resident camera source ownership", () => {
  test("removing a camera aborts only its pending preparation and preserves an active peer", async () => {
    const peer = mediaPeer();
    peers.push(peer);
    await peer.install();
    const playback = new PlaybackManager(async (_revision, did, channel) =>
      manager.prepare(did, channel),
    );
    playbacks.push(playback);
    const manager = new CameraSourceManager(peer.adapter, playback, () => {});
    sources.push(manager);
    await manager.update([camera]);
    const viewer = playback.reserve("revision", camera.did, 1);
    await playback.offer("revision", viewer.id, "offer", signal());
    const entered = deferred<AbortSignal>();
    const preparation = spyOn(
      peer.adapter,
      "prepareCamera",
    ).mockImplementationOnce((_id, _device, requestSignal) => {
      if (!requestSignal)
        throw new Error("Expected camera preparation cancellation");
      entered.resolve(requestSignal);
      return new Promise<void>((_resolve, reject) => {
        requestSignal.addEventListener(
          "abort",
          () => reject(requestSignal.reason),
          { once: true },
        );
      });
    });
    try {
      const updating = manager.update([
        camera,
        { ...camera, did: "pending-camera" },
      ]);
      const requestSignal = await entered.promise;
      await manager.update([camera]);
      await updating;
      expect(requestSignal.aborted).toBe(true);
      expect(playback.snapshot(viewer.id).phase).toBe("active");
      expect(() => manager.validate("pending-camera", 1)).toThrow();
    } finally {
      preparation.mockRestore();
    }
  });

  test("dual lenses keep distinct backend sources and a failed lens preparation cannot retire the other viewer", async () => {
    // MiLoCo cameraChannel.test.ts covers synthetic did:ch0/ch1 identities.
    // This boundary uses one physical did with explicit 1/2 channels and source IDs;
    // it does not exercise the Go MISS connection shared by the physical camera.
    const peer = mediaPeer();
    peers.push(peer);
    await peer.install();
    const playback = new PlaybackManager(async (_revision, did, channel) =>
      manager.prepare(did, channel),
    );
    playbacks.push(playback);
    const cleanupFailed = mock(() => {});
    const manager = new CameraSourceManager(
      peer.adapter,
      playback,
      cleanupFailed,
    );
    sources.push(manager);
    const entered = deferred();
    const failedLens = deferred<Response>();
    peer.handlers.set("PUT camera", (call) => {
      if (call.body.channel === 1) {
        entered.resolve();
        return failedLens.promise;
      }
      return new Response(null, { status: 204 });
    });
    const dual = {
      did: "physical-camera",
      model: "chuangmi.camera.068ac1",
      isOnline: true,
    };
    const updating = manager.update([dual]);
    try {
      await entered.promise;
      const viewer = playback.reserve("revision", dual.did, 2);
      await playback.offer(
        "revision",
        viewer.id,
        "healthy-lens-offer",
        signal(),
      );
      expect(playback.snapshot(viewer.id).phase).toBe("active");
      failedLens.resolve(
        Response.json({ code: "camera_unavailable" }, { status: 503 }),
      );
      await updating;
      const prepared = peer.calls.filter(
        (call) => call.path === "camera" && call.method === "PUT",
      );
      expect(prepared).toHaveLength(2);
      expect(
        prepared.map((call) => [call.body.did, call.body.channel]),
      ).toEqual(
        expect.arrayContaining([
          [dual.did, 1],
          [dual.did, 2],
        ]),
      );
      const first = prepared.find((call) => call.body.channel === 1)!.body
        .sourceId;
      const second = prepared.find((call) => call.body.channel === 2)!.body
        .sourceId;
      expect(first).toBeString();
      expect(second).toBeString();
      expect(first).not.toBe(second);
      expect(
        peer.calls
          .filter((call) => call.path === "camera" && call.method === "DELETE")
          .map((call) => call.body.sourceId),
      ).toEqual([first]);
      expect(
        peer.calls.find(
          (call) => call.path === "playback" && call.method === "POST",
        )?.body,
      ).toMatchObject({ sourceId: second, playbackId: viewer.id });
      expect(playback.snapshot(viewer.id).phase).toBe("active");
      expect(cleanupFailed).not.toHaveBeenCalled();
    } finally {
      failedLens.resolve(
        Response.json({ code: "camera_unavailable" }, { status: 503 }),
      );
      await updating;
    }
  });

  test("offline catalog hint does not block media; shared source is prepared once and removal revokes its viewers", async () => {
    const peer = mediaPeer();
    peers.push(peer);
    await peer.install();
    const playback = new PlaybackManager(async (_revision, did, channel) =>
      manager.prepare(did, channel),
    );
    playbacks.push(playback);
    const manager = new CameraSourceManager(peer.adapter, playback, () => {});
    sources.push(manager);
    await manager.update([camera]);
    const first = playback.reserve("revision", camera.did, 1);
    const second = playback.reserve("revision", camera.did, 1);
    await Promise.all([
      playback.offer("revision", first.id, "offer", signal()),
      playback.offer("revision", second.id, "offer", signal()),
    ]);
    expect(
      peer.calls.filter(
        (call) => call.path === "camera" && call.method === "PUT",
      ),
    ).toHaveLength(1);
    expect(() => manager.validate(camera.did, 2)).toThrow();
    await manager.update([]);
    expect(() => playback.snapshot(first.id)).toThrow();
    expect(() => playback.snapshot(second.id)).toThrow();
    expect(
      peer.calls.filter(
        (call) => call.path === "camera" && call.method === "DELETE",
      ),
    ).toHaveLength(1);
    await expect(manager.prepare(camera.did, 1)).rejects.toMatchObject({
      reason: "camera_invalid",
    });
  });
});

describe("private media session boundary", () => {
  test("closing drains an initialization waiting for its URL without creating a late adapter", async () => {
    const peer = mediaPeer();
    peers.push(peer);
    const entered = deferred();
    const url = deferred<string>();
    const session = new MediaSession({
      onChange: () => {},
      readUrl: () => {
        entered.resolve();
        return url.promise;
      },
      currentAccount: () => undefined,
      acceptsWork: () => true,
      canBind: () => false,
      stopped: () => false,
      canReconfigure: () => true,
    });
    sessions.push(session);
    const initializing = session.initialize();
    await entered.promise;
    const closing = session.close();
    expect(session.close()).toBe(closing);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    try {
      await nextTurn();
      expect(closed).toBe(false);
      expect(peer.calls).toEqual([]);
    } finally {
      url.resolve(peer.adapter.url);
      await Promise.all([initializing, closing]);
    }
    expect(closed).toBe(true);
    expect(peer.calls).toEqual([]);
    await session.initialize();
    await session.startBinding();
    expect(peer.calls).toEqual([]);
  });

  test("scope revocation changes revision synchronously and retries failed cleanup while no household is ready", async () => {
    const peer = mediaPeer();
    peers.push(peer);
    const account = accountClient();
    let ready = true;
    let awaitingCleanup = false;
    const cleanupRecovered = deferred();
    const session = new MediaSession({
      onChange: () => {
        if (!awaitingCleanup) return;
        if (session.binding.status === "unbound") cleanupRecovered.resolve();
      },
      readUrl: async () => peer.adapter.url,
      currentAccount: () => account,
      acceptsWork: () => true,
      canBind: () => ready,
      stopped: () => false,
      canReconfigure: () => true,
    });
    sessions.push(session);
    await session.initialize();
    session.updateDevices([camera]);
    await session.startBinding();
    expect(session.binding.status).toBe("ready");
    const revision = session.mediaRevision;
    const { id } = session.reservePlayback(revision, camera.did, 1);
    jest.useFakeTimers();
    ready = false;
    peer.handlers.set("DELETE session", () =>
      Response.json({ code: "go2rtc_unavailable" }, { status: 503 }),
    );
    session.prepareRebind();
    awaitingCleanup = true;
    const cleanup = session.clearAdapter().catch((error: unknown) => error);
    expect(session.mediaRevision).not.toBe(revision);
    expect(() => session.playbackSnapshot(id)).toThrow();
    expect(() => session.reservePlayback(revision, camera.did, 1)).toThrow();
    expect(await cleanup).toMatchObject({ reason: "go2rtc_unavailable" });
    // Cleanup preserves the adapter error code; consumers cannot identify a
    // pending cleanup solely by looking for mijia_go2rtc_cleanup.
    expect(session.binding).toMatchObject({
      status: "error",
      error: { code: "mijia_go2rtc_unavailable" },
    });
    peer.handlers.delete("DELETE session");
    jest.advanceTimersByTime(6_000);
    await cleanupRecovered.promise;
    expect(session.binding).toEqual({ status: "unbound" });
    expect(
      peer.calls.filter(
        (call) => call.path === "session" && call.method === "PUT",
      ),
    ).toHaveLength(1);
    expect(
      peer.calls.filter(
        (call) =>
          call.path === "session" &&
          call.method === "DELETE" &&
          !call.body.reset,
      ),
    ).toHaveLength(2);
    account.dispose();
  });
  test("revoke immediately prevents new work while failed session cleanup retains the same remote target", async () => {
    const { adapter, handlers, calls } = await setup();
    const installed = calls.find(
      (call) => call.path === "session" && call.method === "PUT",
    )?.body.sessionId;
    adapter.revoke();
    await expect(
      adapter.prepareCamera(sourceId, {
        deviceId: camera.did,
        channel: 1,
        channelCount: 1,
        model: camera.model,
      }),
    ).rejects.toMatchObject({ code: "session_expired" });
    handlers.set("DELETE session", () =>
      Response.json({ code: "go2rtc_unavailable" }, { status: 503 }),
    );
    await expect(adapter.close()).rejects.toMatchObject({
      code: "go2rtc_unavailable",
    });
    handlers.delete("DELETE session");
    await adapter.close();
    await adapter.close();
    expect(
      calls
        .filter((call) => call.path === "session" && call.method === "DELETE")
        .map((call) => call.body.sessionId),
    ).toEqual([installed, installed]);
    expect(calls.every((call) => call.application === "mijia")).toBe(true);
  });

  test("aborting one viewer's lease wait cannot cancel the shared heartbeat", async () => {
    const { adapter, handlers, calls } = await setup();
    const entered = deferred();
    const response = deferred<Response>();
    handlers.set("POST heartbeat", () => {
      entered.resolve();
      return response.promise;
    });
    const before = calls.filter((call) => call.path === "heartbeat").length;
    const caller = new AbortController();
    const cancelled = adapter.renewSessionLease(caller.signal);
    const surviving = adapter.renewSessionLease();
    await entered.promise;
    caller.abort();
    await expect(cancelled).rejects.toMatchObject({
      code: "request_cancelled",
    });
    response.resolve(Response.json({ playbackIds: [] }));
    await surviving;
    expect(calls.filter((call) => call.path === "heartbeat")).toHaveLength(
      before + 1,
    );
    await adapter.prepareCamera(sourceId, {
      deviceId: camera.did,
      channel: 1,
      channelCount: 1,
      model: camera.model,
    });
  });

  test("heartbeat only retires viewers captured before its request; newer playback is not declared ended", async () => {
    const old = crypto.randomUUID();
    const newer = crypto.randomUUID();
    let active = [old];
    const ended = mock((_ids: readonly string[]) => {});
    const peer = mediaPeer({
      onLost: () => {},
      activePlaybackIds: () => active,
      onPlaybackEnded: ended,
    });
    peers.push(peer);
    await peer.install();
    ended.mockClear();
    const entered = deferred();
    const response = deferred<Response>();
    peer.handlers.set("POST heartbeat", () => {
      entered.resolve();
      return response.promise;
    });
    const heartbeat = peer.adapter.renewSessionLease();
    await entered.promise;
    active = [old, newer];
    response.resolve(Response.json({ playbackIds: [] }));
    await heartbeat;
    expect(ended).toHaveBeenCalledWith([old]);
  });

  test("unrelated playback identity in a successful HTTP response is never accepted", async () => {
    const { playback, handlers } = await setup();
    handlers.set("POST playback", () =>
      Response.json({ playbackId: crypto.randomUUID(), answer: "answer" }),
    );
    const { id } = playback.reserve("revision", camera.did, 1);
    await expect(
      playback.offer("revision", id, "offer", signal()),
    ).rejects.toThrow();
    expect(() => playback.snapshot(id)).toThrow();
  });
});
