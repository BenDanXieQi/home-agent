import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createDetector } from "../../src/perception/detection/detector";
import { createReid } from "../../src/perception/tracking/reid";
import { createHumanTracker } from "../../src/perception/tracking/tracker";

// External public video and human annotations: no generated tracking output is
// used as truth, and this test never downloads data or calls a remote service.
const video = process.env.PERCEPTION_TUD_VIDEO_PATH;
const labels = process.env.PERCEPTION_TUD_LABELS_PATH;
test.skipIf(!video || !labels)(
  "real crossing video preserves matched pedestrian identities across sampled observations",
  async () => {
    const bytes = await Bun.file(video!).arrayBuffer();
    expect(
      createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    ).toBe("057efff329eb73f3434649f9b21b37d0d3ca7de8f194524140161e2d13a6ae33");
    const annotations = await Bun.file(labels!).text();
    expect(createHash("sha256").update(annotations).digest("hex")).toBe(
      "009b3ef8df68c963fd8104350083fd6bc9798b6b435858b99dbd1385cfbde873",
    );
    const truth = new Map<
      number,
      { id: number; x: number; y: number; w: number; h: number }[]
    >();
    for (const line of annotations.trim().split("\n")) {
      const values = line.split(",").map(Number);
      const [frame, id, x, y, w, h] = values;
      if (values.length !== 10 || values.some((v) => !Number.isFinite(v)))
        throw new Error("Invalid MOT human annotations");
      const list = truth.get(frame!) ?? [];
      list.push({ id: id!, x: x!, y: y!, w: w!, h: h! });
      truth.set(frame!, list);
    }
    const detector = await createDetector(),
      model = await createReid(),
      tracker = createHumanTracker();
    const decoder = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        video!,
        "-vf",
        "select=not(mod(n\\,8))",
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
    const exited = new Promise<number | null>((resolve, reject) => {
      decoder.once("exit", resolve);
      decoder.once("error", reject);
    });
    const history = new Map<number, { trackId: number; at: number }>();
    let pending = Buffer.alloc(0),
      index = 0,
      matched = 0,
      switches = 0;
    try {
      for await (const chunk of decoder.stdout) {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 640 * 480 * 3) {
          const rgb = new Uint8Array(pending.subarray(0, 640 * 480 * 3));
          pending = pending.subarray(640 * 480 * 3);
          const at = ((index * 8) / 25) * 1000;
          const detections = (
            await detector.detect({ width: 640, height: 480, rgb })
          ).detections;
          const input = tracker.begin(at, detections),
            features = input.cached.map((c) => c?.vector ?? null);
          const missing = input.humans.flatMap((_, i) =>
            features[i] ? [] : [i],
          );
          const vectors = await model.extract({
            frame: { width: 640, height: 480, rgb },
            boxes: missing.map((i) => input.humans[i]!),
          });
          missing.forEach((i, j) => {
            features[i] = vectors[j]!;
          });
          const result = tracker.finish(input, features);
          const candidates = [];
          for (const track of result) {
            const box = track.measuredBox;
            if (!box) continue;
            for (const target of truth.get(index * 8 + 1) ?? []) {
              const area =
                Math.max(
                  0,
                  Math.min(box.x + box.w, target.x + target.w) -
                    Math.max(box.x, target.x),
                ) *
                Math.max(
                  0,
                  Math.min(box.y + box.h, target.y + target.h) -
                    Math.max(box.y, target.y),
                );
              const overlap =
                area / (box.w * box.h + target.w * target.h - area);
              if (overlap >= 0.5)
                candidates.push({
                  overlap,
                  trackId: track.trackId,
                  targetId: target.id,
                });
            }
          }
          const usedTracks = new Set<number>(),
            usedTargets = new Set<number>();
          for (const pair of candidates.toSorted(
            (a, b) => b.overlap - a.overlap,
          )) {
            if (usedTracks.has(pair.trackId) || usedTargets.has(pair.targetId))
              continue;
            usedTracks.add(pair.trackId);
            usedTargets.add(pair.targetId);
            matched++;
            const previous = history.get(pair.targetId);
            if (
              previous &&
              at - previous.at <= 2000 &&
              pair.trackId !== previous.trackId
            )
              switches++;
            history.set(pair.targetId, { trackId: pair.trackId, at });
          }
          index++;
        }
      }
      expect(await exited).toBe(0);
      expect(index).toBe(23);
      expect(matched).toBeGreaterThanOrEqual(100);
      expect(switches).toBe(0);
    } finally {
      decoder.kill("SIGKILL");
      await exited;
      await detector.close();
      await model.close();
    }
  },
  15000,
);
