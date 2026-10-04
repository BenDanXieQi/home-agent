import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { z } from "zod";
import writeFileAtomic from "write-file-atomic";
import { createDetector } from "../src/perception/detection/detector";
import { detectionModelPath } from "../src/perception/detection/model";
import { createReid } from "../src/perception/tracking/reid";
import { createHumanTracker } from "../src/perception/tracking/tracker";
import {
  reidProcessingVersion,
  appearanceOverlapIou,
} from "../src/perception/tracking/feature-version";
import { frameSchema, frameLimits } from "../src/perception/detection/frame";
import { createPerceptionEnvironment } from "./perception-report";

const manifestSchema = z.strictObject({
  sourcePage: z.url(),
  attribution: z.string().min(1),
  license: z.url(),
  videos: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        url: z.url(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        provenancePath: z.string().min(1).optional(),
        licensePath: z.string().min(1).optional(),
      }),
    )
    .min(1)
    .max(8),
});
const probeSchema = z.object({
  streams: z
    .array(
      z.object({
        width: z.int().positive().max(frameLimits.maxDimension),
        height: z.int().positive().max(frameLimits.maxDimension),
        avg_frame_rate: z.string(),
      }),
    )
    .length(1),
  frames: z
    .array(
      z.object({
        best_effort_timestamp_time: z.coerce
          .number()
          .finite()
          .nonnegative()
          .optional(),
      }),
    )
    .min(1),
});
const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    "output-dir": { type: "string" },
    seconds: { type: "string", default: "302" },
    "identity-model-dir": { type: "string" },
  },
  strict: true,
});
if (!values.manifest || !values["output-dir"])
  throw new Error(
    "Usage: analyze-appearance-video --manifest <licensed video input JSON> --output-dir <report> [--seconds 302] [--identity-model-dir <YuNet/SFace>]",
  );
const seconds = z.coerce.number().positive().max(3600).parse(values.seconds);
const manifestBytes = await readFile(resolve(values.manifest));
const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString()));
const output = resolve(values["output-dir"]);
async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const quantile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: quantile(0.5),
    p95: quantile(0.95),
    max: sorted.at(-1) ?? null,
  };
}
async function readVideoProvenance(video: (typeof manifest.videos)[number]) {
  if (!video.provenancePath) return null;
  const bytes = await readFile(resolve(video.provenancePath));
  if (bytes.length > 256 * 1024)
    throw new Error("Source provenance exceeds the metadata budget");
  const value = z
    .object({
      source: z.object({ url: z.url() }).passthrough(),
      clip: z.object({ sha256: z.string() }).passthrough(),
    })
    .passthrough()
    .parse(JSON.parse(bytes.toString()));
  if (value.clip.sha256 !== video.sha256 || value.source.url !== video.url)
    throw new Error("Source provenance does not match this video");
  return {
    ...value,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function analyze(video: (typeof manifest.videos)[number]) {
  const path = resolve(video.path);
  if ((await hashFile(path)) !== video.sha256)
    throw new Error(`Video fingerprint mismatch: ${path}`);
  const provenance = await readVideoProvenance(video);
  const { stdout } = await promisify(execFile)(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-read_intervals",
      `%+${seconds + 0.1}`,
      "-show_frames",
      "-show_entries",
      "stream=width,height,avg_frame_rate:frame=best_effort_timestamp_time",
      "-of",
      "json",
      path,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const probe = probeSchema.parse(JSON.parse(stdout));
  const metadata = probe.streams[0]!;
  const [numerator, denominator] = metadata.avg_frame_rate
    .split("/")
    .map(Number);
  const sourceFps = z
    .number()
    .positive()
    .max(240)
    .parse(numerator! / denominator!);
  const stride = Math.max(1, Math.ceil(sourceFps / 3));
  if (metadata.width * metadata.height > frameLimits.maxPixels)
    throw new Error("Video exceeds the production RGB24 pixel budget");
  const origin = probe.frames[0]!.best_effort_timestamp_time;
  if (origin === undefined)
    throw new Error("First presentation timestamp is unavailable");
  const validTimes = probe.frames.flatMap((frame) =>
    frame.best_effort_timestamp_time === undefined
      ? []
      : [frame.best_effort_timestamp_time],
  );
  if (
    validTimes.some(
      (time, index) => index > 0 && time <= validTimes[index - 1]!,
    )
  )
    throw new Error("Decoded presentation timestamps must strictly increase");
  const selected = probe.frames.flatMap((frame, index) => {
    if (index % stride !== 0) return [];
    const pts = frame.best_effort_timestamp_time;
    if (pts === undefined)
      throw new Error(`Sampled frame ${index} has no presentation timestamp`);
    const time = (pts - origin) * 1000;
    return time < seconds * 1000
      ? [{ sourceFrameIndex: index, time, presentationTimeMs: pts * 1000 }]
      : [];
  });
  const detector = await createDetector();
  const model = await createReid().catch(async (error: unknown) => {
    await detector.close();
    throw error;
  });
  const identity = values["identity-model-dir"]
    ? await import("./perception-evaluation/video-identity")
        .then((module) =>
          module.createVideoIdentityAnalysis(
            resolve(values["identity-model-dir"]!),
            `calibration:${video.sha256.slice(0, 16)}`,
          ),
        )
        .catch(async (error: unknown) => {
          try {
            await model.close();
          } finally {
            await detector.close();
          }
          throw error;
        })
    : null;
  const tracker = createHumanTracker();
  const trackFeatures = new Map<
    number,
    { firstAt: number; lastAt: number; fresh: number; intervalsMs: number[] }
  >();
  function frameReport(
    sequence: number,
    sample: (typeof selected)[number],
    detections: Awaited<ReturnType<typeof detector.detect>>["detections"],
    input: ReturnType<typeof tracker.begin>,
    tracks: ReturnType<typeof tracker.finish>,
    freshTrackIds: number[],
    faceTrackIds: Set<number>,
    missing: number[],
    identityResult: Awaited<
      ReturnType<NonNullable<typeof identity>["step"]>
    > | null,
  ) {
    return {
      sequence,
      ...sample,
      identity: identityResult,
      humanDetections: detections.filter(
        (detection) => detection.className === "human",
      ).length,
      faceDetections: detections.filter(
        (detection) => detection.className === "face",
      ).length,
      reidExtractions: missing.length,
      overlapFilteredFresh: missing.filter(
        (index) => !input.appearanceEligible[index],
      ).length,
      freshTrackIds,
      faceTrackIds: [...faceTrackIds],
      freshWithFaceDetection: freshTrackIds.filter((trackId) =>
        faceTrackIds.has(trackId),
      ).length,
      tracks: tracks.map(({ trackId, state, feature, hits, measuredBox }) => ({
        trackId,
        state,
        feature,
        hits,
        measuredBox,
      })),
    };
  }
  const frames: ReturnType<typeof frameReport>[] = [];
  const durations: number[] = [];
  let pending = Buffer.alloc(0);
  const pixelBytes = metadata.width * metadata.height * 3;
  let peakRss = process.memoryUsage().rss;
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  let stderr = "";
  let launchError: Error | undefined;
  const decoder = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-noautorotate",
      "-i",
      path,
      "-map",
      "0:v:0",
      "-t",
      String(seconds),
      "-vf",
      `select=not(mod(n\\,${stride}))`,
      "-fps_mode",
      "vfr",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  decoder.on("error", (error) => {
    launchError = error;
  });
  decoder.stderr.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString()).slice(-65536);
  });
  const exited = new Promise<number | null>((done) => {
    decoder.once("close", done);
  });
  try {
    for await (const chunk of decoder.stdout) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= pixelBytes) {
        const sample = selected[frames.length];
        if (!sample)
          throw new Error("Decoder produced an unexpected sampled frame");
        const rgb = new Uint8Array(pending.subarray(0, pixelBytes));
        pending = pending.subarray(pixelBytes);
        const frame = frameSchema.parse({
          width: metadata.width,
          height: metadata.height,
          rgb,
        });
        const at = performance.now();
        const detections = (await detector.detect(frame)).detections;
        const input = tracker.begin(sample.time, detections);
        const features = input.cached.map((cached) => cached?.vector ?? null);
        const missing = input.humans.flatMap((_, index) =>
          features[index] ? [] : [index],
        );
        if (missing.length) {
          const vectors = await model.extract({
            frame,
            boxes: missing.map((index) => input.humans[index]!),
          });
          missing.forEach((index, offset) => {
            features[index] = vectors[offset]!;
          });
        }
        const fresh: Pick<
          z.infer<
            typeof import("../src/household/identity/appearance-evidence").appearanceEvidenceSchema
          >,
          "trackId" | "vector"
        >[] = [];
        const tracks = tracker.finish(input, features, (item) => {
          fresh.push(item);
        });
        const freshTrackIds = fresh.map((item) => item.trackId);
        const measured = tracks.filter((track) => track.state === "measured");
        const faces = detections.filter(
          (detection) => detection.className === "face",
        );
        const faceTrackIds = new Set<number>();
        for (const face of faces) {
          const x = face.x + face.w / 2,
            y = face.y + face.h / 2;
          const matching = measured.filter((track) => {
            const box = track.measuredBox;
            return (
              box &&
              x >= box.x &&
              x < box.x + box.w &&
              y >= box.y &&
              y < box.y + box.h
            );
          });
          if (matching.length === 1) faceTrackIds.add(matching[0]!.trackId);
        }
        for (const trackId of freshTrackIds) {
          const previous = trackFeatures.get(trackId);
          if (previous) {
            previous.intervalsMs.push(sample.time - previous.lastAt);
            previous.lastAt = sample.time;
            previous.fresh++;
          } else
            trackFeatures.set(trackId, {
              firstAt: sample.time,
              lastAt: sample.time,
              fresh: 1,
              intervalsMs: [],
            });
        }
        durations.push(performance.now() - at);
        const identityResult = identity
          ? await identity.step({
              frame,
              tracks,
              fresh,
              timeMs: sample.time,
              ptsMs: sample.presentationTimeMs,
              sourceFrameIndex: sample.sourceFrameIndex,
              sequence: frames.length + 1,
              omittedHumans: Math.max(
                0,
                detections.filter((item) => item.className === "human").length -
                  measured.length,
              ),
              omittedPets: detections.filter(
                (item) => item.className === "cat" || item.className === "dog",
              ).length,
            })
          : null;
        frames.push(
          frameReport(
            frames.length + 1,
            sample,
            detections,
            input,
            tracks,
            freshTrackIds,
            faceTrackIds,
            missing,
            identityResult,
          ),
        );
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        if (frames.length % 100 === 0)
          console.log(
            `${path}: ${frames.length}/${selected.length} sampled frames`,
          );
      }
    }
    const code = await exited;
    if (launchError) throw launchError;
    if (code !== 0 || stderr)
      throw new Error(`FFmpeg failed (${code}): ${stderr}`);
    if (pending.length || frames.length !== selected.length)
      throw new Error(
        `Incomplete decoding: ${frames.length}/${selected.length} sampled frames`,
      );
  } finally {
    decoder.kill("SIGKILL");
    await exited;
    try {
      await identity?.close();
    } finally {
      try {
        await model.close();
      } finally {
        await detector.close();
      }
    }
  }
  const cpu = process.cpuUsage(cpuStart);
  const sum = (
    field:
      | "faceDetections"
      | "reidExtractions"
      | "overlapFilteredFresh"
      | "freshWithFaceDetection",
  ) => frames.reduce((total, frame) => total + frame[field], 0);
  const measuredCount = frames.reduce(
    (total, frame) =>
      total + frame.tracks.filter((track) => track.state === "measured").length,
    0,
  );
  const freshCount = frames.reduce(
    (total, frame) => total + frame.freshTrackIds.length,
    0,
  );
  const faceTargetCount = frames.reduce(
    (total, frame) => total + frame.faceTrackIds.length,
    0,
  );
  const identitySummary = identity?.snapshot() ?? null;
  const confirmedSupports =
    identitySummary?.statistics.newConfirmedFaceSupports ?? 0;
  const jointSupports =
    identitySummary?.statistics.newConfirmedSupportWithFreshBody ?? 0;
  const targetFresh =
    identitySummary?.statistics.targetFreshBodyObservations ?? 0;
  return {
    identity: identitySummary,
    source: {
      ...video,
      provenance,
      path,
      width: metadata.width,
      height: metadata.height,
      sourceFps,
      probedSourceFrames: probe.frames.length,
      originPresentationTimeMs: origin * 1000,
      unselectedFramesWithoutTimestamp: probe.frames.filter(
        (frame) => frame.best_effort_timestamp_time === undefined,
      ).length,
    },
    models: {
      detector: {
        ...detector.metadata,
        sha256: await hashFile(detectionModelPath),
        minimumConfidence: 0.5,
      },
      reid: { ...model.metadata, processingVersion: reidProcessingVersion },
      appearanceOverlapIou,
    },
    sampling: {
      stride,
      requestedFps: 3,
      nominalFps: sourceFps / stride,
      requestedSeconds: seconds,
      frames: frames.length,
      firstMediaMs: frames[0]?.time ?? null,
      lastMediaMs: frames.at(-1)?.time ?? null,
      sampleIntervalsMs: distribution(
        selected
          .slice(1)
          .map((sample, index) => sample.time - selected[index]!.time),
      ),
      missedRealtimeFrames: null,
      scope:
        "sequential offline backpressure, original pixels and decoded PTS; no live scheduling",
    },
    availability: {
      measuredTargetObservations: measuredCount,
      faceDetections: sum("faceDetections"),
      uniqueFaceTargetObservations: faceTargetCount,
      reidExtractions: sum("reidExtractions"),
      reidInvocations: frames.filter((frame) => frame.reidExtractions > 0)
        .length,
      detectorInvocations: frames.length,
      overlapFilteredFresh: sum("overlapFilteredFresh"),
      eligibleFreshTargetObservations: freshCount,
      freshWithFaceDetection: sum("freshWithFaceDetection"),
      faceDetectionAmongFreshRatio: freshCount
        ? sum("freshWithFaceDetection") / freshCount
        : null,
      freshAmongFaceDetectedRatio: faceTargetCount
        ? sum("freshWithFaceDetection") / faceTargetCount
        : null,
      reusedObservations: frames.reduce(
        (total, frame) =>
          total +
          frame.tracks.filter((track) => track.feature === "reused").length,
        0,
      ),
      predictedObservations: frames.reduce(
        (total, frame) =>
          total +
          frame.tracks.filter((track) => track.state === "predicted").length,
        0,
      ),
      framesWithoutMeasuredHuman: frames.filter(
        (frame) => !frame.tracks.some((track) => track.state === "measured"),
      ).length,
      freshIntervalsMs: distribution(
        [...trackFeatures.values()].flatMap((track) => track.intervalsMs),
      ),
      confirmedFaceJointAvailability: identitySummary
        ? {
            newConfirmedSupports: confirmedSupports,
            jointNewConfirmedAndFreshBody: jointSupports,
            targetFreshBodyObservations: targetFresh,
            freshAmongNewConfirmedRatio: confirmedSupports
              ? jointSupports / confirmedSupports
              : null,
            newConfirmedAmongFreshRatio: targetFresh
              ? jointSupports / targetFresh
              : null,
            meaning:
              "actual new accepted face supports belonging to the current confirmed state, not participant GT accuracy",
          }
        : null,
      inferenceFlashes: null,
      attributionLatencyMs: null,
    },
    tracks: [...trackFeatures].map(([trackId, track]) => ({
      trackId,
      ...track,
      intervals: distribution(track.intervalsMs),
    })),
    frames,
    resources: {
      wallMs: performance.now() - started,
      cpuMs: (cpu.user + cpu.system) / 1000,
      sampledProcessRssPeakBytes: peakRss,
      detectAndTrackMs: distribution(durations),
      scope:
        "offline process sampled each frame, not online domain cache or multi-source concurrent load",
    },
  };
}
await mkdir(output, { recursive: true });
const sources = [];
for (const [index, video] of manifest.videos.entries()) {
  const result = await analyze(video);
  const { frames, ...summary } = result;
  await writeFileAtomic(
    join(output, `source-${index + 1}-frames.json`),
    JSON.stringify(frames, null, 2) + "\n",
  );
  if (video.licensePath) {
    const notice = await readFile(resolve(video.licensePath));
    if (notice.length > 256 * 1024)
      throw new Error("License notice exceeds the metadata budget");
    await writeFileAtomic(
      join(output, `source-${index + 1}-license.txt`),
      notice,
    );
  }
  sources.push(summary);
  await writeFileAtomic(
    join(output, "results.json"),
    JSON.stringify(
      {
        ...manifest,
        manifestSha256: createHash("sha256")
          .update(manifestBytes)
          .digest("hex"),
        ...(await createPerceptionEnvironment()),
        limitations: [
          "face detector outputs are not quality-accepted or confirmed face identity",
          "no global person identity or family reference labels",
          "no score/TTL calibration from this input",
          "no skipped-live-input or async face/body timing coverage",
          "track intervals do not prove same-person continuity",
          "no activity transaction or UI acceptance",
        ],
        sources,
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(JSON.stringify(sources, null, 2));
