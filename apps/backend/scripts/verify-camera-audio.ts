import { parseArgs, promisify } from "node:util";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { z } from "zod";
import { snapshotSchema } from "@home-agent/api/household";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { createDatabase } from "../src/db";
import { createCredentialStore } from "../src/credentials/store";
import { readCredentialKey } from "../src/credentials/key";
import { accountSessionSchema } from "../src/mijia/account/session";
import { MiCloud } from "../src/mijia/protocols/micloud";
import { Go2RtcAdapter } from "../src/mijia/media/go2rtc-adapter";
import { readAudioStream } from "../src/mijia/media/audio-stream";
import { createPerceptionService } from "../src/perception/service";
import { createPerceptionRoutes } from "../src/perception/routes";
import { sourceSelectionSchema, sourceKey } from "../src/perception/config";
import type { PerceptionSources } from "../src/perception/sources";
import { createAudioResourceSampler } from "./perception-evaluation/audio-resources";

const { values } = parseArgs({
  options: {
    binary: { type: "string" },
    key: { type: "string" },
    management: { type: "string", default: "http://127.0.0.1:3000" },
    seconds: { type: "string", default: "300" },
  },
});
const binary = z.string().min(1).parse(values.binary);
const key = z.string().min(1).parse(values.key);
const seconds = z.coerce.number().int().min(30).max(3600).parse(values.seconds);
const databaseUrl = z.string().min(1).parse(process.env.DATABASE_URL);
// Refuse an occupied API port instead of adopting another instance's session.
const probe = createServer();
const listening = once(probe, "listening");
probe.listen(1986, "127.0.0.1");
await listening;
await promisify(probe.close.bind(probe))();
const native = spawn(
  binary,
  [
    "-config",
    JSON.stringify({
      api: { listen: "127.0.0.1:1986" },
      rtsp: { listen: "" },
      webrtc: {
        listen: "127.0.0.1:18556",
        candidates: ["127.0.0.1:18556"],
        filters: { loopback: true },
      },
      log: { level: "error" },
      streams: {},
    }),
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
let nativeFailure: unknown;
const nativeExit = once(native, "exit").catch((error: unknown) => {
  nativeFailure = error;
});
let directory: string | undefined;
let db: ReturnType<typeof createDatabase> | undefined;
const shutdown = new AbortController();
process.once("SIGINT", () => {
  shutdown.abort();
});
process.once("SIGTERM", () => {
  shutdown.abort();
});
const failures: string[] = [];
const playback = new Map<string, Parameters<Go2RtcAdapter["offer"]>[0]>();
const adapter = new Go2RtcAdapter("http://127.0.0.1:1986", {
  onLost(error) {
    failures.push(error.code);
  },
  activePlaybackIds: () => [...playback.keys()],
  onPlaybackEnded(ids) {
    for (const id of ids) playback.delete(id);
  },
});
let cloud: ReturnType<typeof MiCloud.restoreSession> | undefined;
let service: ReturnType<typeof createPerceptionService> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  directory = await mkdtemp(join(tmpdir(), "camera-audio-"));
  db = createDatabase(databaseUrl);
  for (let attempt = 0; ; attempt++) {
    if (nativeFailure || native.exitCode !== null)
      throw nativeFailure ?? new Error("Owned go2rtc exited during startup");
    try {
      const response = await fetch("http://127.0.0.1:1986/api", {
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.ok) break;
    } catch (error) {
      if (attempt >= 20) throw error;
    }
    if (attempt >= 20) throw new Error("Owned go2rtc did not start");
    await delay(100);
  }
  const initial = snapshotSchema.parse(
    await (await fetch(`${values.management}/api/mijia/state`)).json(),
  );
  const devices = Object.values(initial.projection.device).filter(
    (device) => device.camera,
  );
  if (!devices.length)
    throw new Error("No committed cameras available for verification");
  const workroom = Object.values(initial.projection.room).find(
    (room) => room.name === "工作室",
  );
  devices.sort(
    (a, b) =>
      Number(b.room_id === workroom?.room_id) -
      Number(a.room_id === workroom?.room_id),
  );
  const selected = devices.flatMap((device) =>
    device.channels.map((channel) => ({ deviceId: device.id, channel })),
  );
  const saved = await createCredentialStore(db.db, () =>
    readCredentialKey(key),
  ).read("mijia");
  cloud = MiCloud.restoreSession(
    accountSessionSchema.parse(saved?.value).micloud,
  );
  const catalog = await cloud.getCatalog();
  await adapter.install(cloud.getCredentials());
  const entries = new Map<string, { id: string; pending: Promise<void> }>();
  const sources = {
    list: () => selected,
    eligibility: (source) =>
      !shutdown.signal.aborted &&
      selected.some((item) => sourceKey(item) === sourceKey(source))
        ? {
            scopeEpoch: initial.scope_epoch,
            identity: initial.scope_epoch,
            householdVersion: {
              scope_epoch: initial.scope_epoch,
              sequence: initial.sequence,
            },
          }
        : null,
    subscribe: () => () => {},
    async prepare(source, signal) {
      const cameraKey = sourceKey(source);
      let entry = entries.get(cameraKey);
      if (!entry) {
        const device = catalog.devices.find(
          (candidate) => candidate.did === source.deviceId,
        );
        const committed = devices.find(
          (candidate) => candidate.id === source.deviceId,
        );
        if (!device?.model || !device.localip || !committed)
          throw new Error("Committed camera is unavailable");
        const id = crypto.randomUUID();
        entry = {
          id,
          pending: adapter.prepareCamera(
            id,
            {
              deviceId: device.did,
              channel: source.channel,
              channelCount: committed.channels.length === 2 ? 2 : 1,
              model: device.model,
              localIp: z.string().parse(device.localip),
            },
            signal,
          ),
        };
        entries.set(cameraKey, entry);
      }
      await entry.pending;
      signal.throwIfAborted();
      return {
        access: adapter.analysisAccess(entry.id),
        signal: shutdown.signal,
      };
    },
  } satisfies PerceptionSources;
  const formats = [];
  for (const device of devices) {
    const prepared = await sources.prepare(
      { deviceId: device.id, channel: device.channels[0]! },
      shutdown.signal,
    );
    const stream = await readAudioStream(
      prepared.access,
      AbortSignal.any([shutdown.signal, AbortSignal.timeout(15000)]),
    );
    formats.push({
      name: device.name,
      format: stream.format,
      decodedStartOffsetMs: stream.decodedStartOffsetMs,
    });
    await stream.stream.cancel();
  }
  const configPath = join(directory, "perception.json");
  await writeFile(
    configPath,
    JSON.stringify({ sources: selected, cpuRatio: 0.5 }),
  );
  service = createPerceptionService({
    configPath,
    executable: process.env.PERCEPTION_FFMPEG_PATH ?? "ffmpeg",
    sources,
  });
  const current = service;
  const app = new Hono();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: app.fetch,
  });
  const port = server.port;
  if (!port) throw new Error("Verification server did not bind");
  app.use(requireLocalAccess([port]));
  app.route(
    "/api/perception",
    createPerceptionRoutes(service, port, shutdown.signal, 130_000),
  );
  app.get("/cameras", (c) =>
    c.json(
      selected.map((source) => ({
        ...source,
        name: devices.find((candidate) => candidate.id === source.deviceId)!
          .name,
      })),
    ),
  );
  app.post("/webrtc", async (c) => {
    const input = sourceSelectionSchema
      .extend({ sdp: z.string().min(1) })
      .parse(await c.req.json());
    if (!sources.eligibility(input))
      return c.json({ error: "source unavailable" }, 409);
    await sources.prepare(input, shutdown.signal);
    const owner = {
      id: crypto.randomUUID(),
      sourceId: entries.get(sourceKey(input))!.id,
    };
    playback.set(owner.id, owner);
    try {
      return c.json(await adapter.offer(owner, input.sdp, shutdown.signal));
    } catch (error) {
      playback.delete(owner.id);
      throw error;
    }
  });
  app.delete("/webrtc/:id", async (c) => {
    const owner = playback.get(c.req.param("id"));
    if (owner) {
      playback.delete(owner.id);
      await adapter.release(owner);
    }
    return c.body(null, 204);
  });
  app.get("/", (c) =>
    c.html(`<!doctype html><meta charset="utf-8"><title>摄像头音视频验证</title><style>body{font:16px system-ui;padding:24px;background:#f5f5f5}section{display:inline-block;width:45%;margin:1%;vertical-align:top}video{width:100%;background:black}pre{white-space:pre-wrap}button{padding:12px;margin-right:12px}</style><h1>摄像头音视频验证</h1><button id="start">开始播放</button><button id="stop">停止播放</button><div id="cameras"></div><pre id="status">等待开始</pre><script>
window.results=[];window.errors=[];const peers=[];
window.stopPlayback=async()=>{for(const item of peers){item.pc.close();await fetch('/webrtc/'+item.id,{method:'DELETE'});}peers.length=0;document.querySelector('#status').textContent='已停止';};
window.startPlayback=async()=>{await window.stopPlayback();document.querySelector('#cameras').replaceChildren();window.results=[];const sources=await(await fetch('/cameras')).json();for(const source of sources){const section=document.createElement('section');const title=document.createElement('p');title.textContent=source.name+' / '+source.channel;const video=document.createElement('video');video.autoplay=true;video.muted=true;video.playsInline=true;section.append(title,video);document.querySelector('#cameras').append(section);const pc=new RTCPeerConnection({iceServers:[]});pc.addTransceiver('video',{direction:'recvonly'});pc.addTransceiver('audio',{direction:'recvonly'});const stream=new MediaStream();video.srcObject=stream;pc.ontrack=event=>{stream.addTrack(event.track);};await pc.setLocalDescription(await pc.createOffer());if(pc.iceGatheringState!=='complete')await new Promise(resolve=>{const timer=setTimeout(resolve,4000);pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);resolve();}});});const response=await fetch('/webrtc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:source.deviceId,channel:source.channel,sdp:pc.localDescription.sdp})});if(!response.ok)throw new Error(await response.text());const answer=await response.json();peers.push({pc,id:answer.id,name:source.name,channel:source.channel});await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});}document.querySelector('#status').textContent='播放中';};
document.querySelector('#start').onclick=()=>window.startPlayback().catch(error=>{window.errors.push(String(error));document.querySelector('#status').textContent=String(error);});document.querySelector('#stop').onclick=()=>window.stopPlayback().catch(error=>window.errors.push(String(error)));
setInterval(async()=>{const results=[];for(const item of peers){const stats=await item.pc.getStats();const incoming=[...stats.values()].filter(value=>value.type==='inbound-rtp');results.push({name:item.name,channel:item.channel,state:item.pc.connectionState,video:incoming.filter(value=>value.kind==='video').map(value=>({framesDecoded:value.framesDecoded,bytesReceived:value.bytesReceived})),audio:incoming.filter(value=>value.kind==='audio').map(value=>({packetsReceived:value.packetsReceived,totalSamplesReceived:value.totalSamplesReceived}))});}window.results=results;if(peers.length)document.querySelector('#status').textContent=JSON.stringify(results,null,2);},1000);
</script>`),
  );
  await service.start();
  console.log(
    JSON.stringify({
      ready: true,
      url: server.url.toString(),
      cameras: devices.length,
      videoChannels: selected.length,
      formats,
    }),
  );
  await delay(15000, undefined, { signal: shutdown.signal });
  const resourceSampler = createAudioResourceSampler();
  const baseline = await resourceSampler.sample();
  const initialView = service.snapshot();
  const audioRuns = new Set(
    initialView.audio.tracks.map((track) => track.run.trackRunId),
  );
  let invalidAudioSamples = 0,
    invalidVideoSamples = 0,
    maxRss = baseline.rssMiB;
  const started = performance.now();
  for (let second = 0; second < seconds; second += 5) {
    await delay(5000, undefined, { signal: shutdown.signal });
    const committed = snapshotSchema.parse(
      await (await fetch(`${values.management}/api/mijia/state`)).json(),
    );
    if (committed.scope_epoch !== initial.scope_epoch)
      throw new Error("Household scope changed; verification stopped");
    const view = current.snapshot();
    if (
      view.audio.tracks.length !== devices.length ||
      view.audio.tracks.some(
        (track) =>
          track.validity !== "valid" || !audioRuns.has(track.run.trackRunId),
      )
    )
      invalidAudioSamples++;
    if (view.sources.some((source) => source.validity !== "valid"))
      invalidVideoSamples++;
    const resources = await resourceSampler.sample();
    maxRss = Math.max(maxRss, resources.rssMiB);
    if ((second + 5) % 60 === 0)
      console.log(
        JSON.stringify({
          progressSeconds: second + 5,
          resources,
          invalidAudioSamples,
          invalidVideoSamples,
          failures,
          samples: view.audio.tracks.map((track) => track.samples),
        }),
      );
  }
  const end = await resourceSampler.sample();
  const view = service.snapshot();
  if (invalidAudioSamples || invalidVideoSamples || failures.length)
    process.exitCode = 1;
  console.log(
    JSON.stringify({
      complete: true,
      seconds,
      cpuPercentOfOneCore:
        ((end.cpuMs - baseline.cpuMs) / (performance.now() - started)) * 100,
      rssMiB: { start: baseline.rssMiB, end: end.rssMiB, max: maxRss },
      invalidAudioSamples,
      invalidVideoSamples,
      failures,
      audio: view.audio.tracks.map((track) => ({
        channels: track.channels,
        samples: track.samples,
        status: track.status,
        validity: track.validity,
      })),
      video: view.sources.map((source) => ({
        channel: source.source.channel,
        published: source.metrics.published,
        validity: source.validity,
      })),
    }),
  );
} finally {
  shutdown.abort();
  const cleanupErrors: unknown[] = [];
  for (const close of [
    () => service?.close(),
    () => server?.stop(true),
    () => adapter.close(),
    () => {
      cloud?.dispose();
    },
    () => db?.close(),
    async () => {
      native.kill("SIGTERM");
      await nativeExit;
    },
    () =>
      directory ? rm(directory, { recursive: true, force: true }) : undefined,
  ]) {
    try {
      await Promise.resolve(close());
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    process.exitCode = 1;
    console.error(
      new AggregateError(cleanupErrors, "Camera verification cleanup failed"),
    );
  }
}
