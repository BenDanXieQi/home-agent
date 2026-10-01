import type { perceptionSnapshotSchema } from "@home-agent/api/contracts";
import type { PlaybackSession } from "../playback/session";

export const presentationLimits = {
  maxWidth: 640,
  maxHeight: 360,
  maxFrames: 48,
  maxBytes: 24 * 1024 * 1024,
  delayMs: 160,
  carryMs: 450,
  maxResults: 48,
  inputSilenceMs: 1000,
};

type Source = ReturnType<
  typeof perceptionSnapshotSchema.parse
>["sources"][number];
type Input = Parameters<
  NonNullable<Parameters<PlaybackSession["attach"]>[0]["onFrame"]>
>[0];

function key(generation: string, timestamp: number) {
  return `${generation}:${timestamp}`;
}

export function createFramePresentation(
  canvas: HTMLCanvasElement,
  changed: () => void,
) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  const pixels = new OffscreenCanvas(1, 1);
  const pixelContext = pixels.getContext("2d");
  if (!pixelContext) throw new Error("Frame capture unavailable");
  const frames: Array<{
    id: string;
    generation: string;
    rtpTimestamp: number;
    bitmap: ImageBitmap;
    availableAt: number;
    bytes: number;
    originalWidth: number;
    originalHeight: number;
  }> = [];
  const results = new Map<
    string,
    { detection: Source["observation"]; tracking: Source["tracking"] }
  >();
  let displayed: (typeof frames)[number] | undefined;
  let layers: {
    detection: Source["observation"];
    tracking: Source["tracking"];
    matching: "same" | "carried" | "none";
    ageMs: number;
  } = { detection: null, tracking: null, matching: "none", ageMs: 0 };
  let runId: string | undefined, generation: string | undefined;
  let frozenRun: string | undefined;
  let active = false,
    frozen = false,
    closed = false;
  let bytes = 0,
    callback = 0,
    lastTimestamp = -1;
  let failure: string | undefined;
  let published = "";
  function notify() {
    const state = `${!!displayed}:${frozen}:${failure ?? ""}`;
    if (state === published) return;
    published = state;
    changed();
  }
  function release(frame: (typeof frames)[number]) {
    frame.bitmap.close();
    bytes -= frame.bytes;
  }
  function clearQueue() {
    for (const pending of frames.splice(0)) release(pending);
  }
  function emptyLayers() {
    layers = { detection: null, tracking: null, matching: "none", ageMs: 0 };
  }
  function chooseLayers() {
    if (frozen) {
      const exact = displayed && results.get(displayed.id);
      if (active && runId === frozenRun && exact) {
        layers = {
          detection: exact.detection ?? layers.detection,
          tracking: exact.tracking ?? layers.tracking,
          matching: "same",
          ageMs: 0,
        };
      }
      return;
    }
    emptyLayers();
    if (
      !displayed ||
      !active ||
      generation !== displayed.generation ||
      performance.now() - displayed.availableAt >
        presentationLimits.inputSilenceMs
    )
      return;
    const exact = results.get(displayed.id);
    if (exact) layers = { ...exact, matching: "same", ageMs: 0 };
    if (!exact) {
      for (const candidate of results.values()) {
        const result = candidate.detection ?? candidate.tracking;
        if (!result || result.mediaTime.generation !== displayed.generation)
          continue;
        const ageMs =
          (displayed.rtpTimestamp - result.mediaTime.rtpTimestamp) / 90;
        if (
          ageMs > 0 &&
          ageMs <= presentationLimits.carryMs &&
          (layers.matching === "none" || ageMs < layers.ageMs)
        )
          layers = { ...candidate, matching: "carried", ageMs };
      }
    }
  }
  function draw() {
    if (!displayed) {
      context!.clearRect(0, 0, canvas.width, canvas.height);
      notify();
      return;
    }
    if (canvas.width !== displayed.bitmap.width)
      canvas.width = displayed.bitmap.width;
    if (canvas.height !== displayed.bitmap.height)
      canvas.height = displayed.bitmap.height;
    context!.drawImage(displayed.bitmap, 0, 0);
    const scaleX = canvas.width / displayed.originalWidth,
      scaleY = canvas.height / displayed.originalHeight;
    context!.lineWidth = 2;
    context!.font = "12px sans-serif";
    for (const detection of layers.detection?.detections ?? []) {
      context!.strokeStyle = "#00e5a0";
      context!.fillStyle = "#00e5a0";
      context!.strokeRect(
        detection.x * scaleX,
        detection.y * scaleY,
        detection.w * scaleX,
        detection.h * scaleY,
      );
      context!.fillText(
        `${detection.className} ${Math.round(detection.confidence * 100)}%`,
        detection.x * scaleX,
        Math.max(14, detection.y * scaleY - 4),
      );
    }
    for (const track of layers.tracking?.tracks ?? []) {
      const box =
        track.state === "measured" ? track.measuredBox : track.predictedBox;
      if (!box) continue;
      context!.strokeStyle = "#ffbf47";
      context!.fillStyle = "#ffbf47";
      context!.setLineDash(track.state === "predicted" ? [4, 3] : []);
      context!.strokeRect(
        box.x * scaleX,
        box.y * scaleY,
        box.w * scaleX,
        box.h * scaleY,
      );
      context!.fillText(
        `#${track.trackId} ${track.state}`,
        box.x * scaleX,
        (box.y + box.h) * scaleY - 4,
      );
      context!.setLineDash([]);
    }
    const label =
      layers.matching === "same"
        ? "同帧结果"
        : layers.matching === "carried"
          ? `沿用 ${Math.round(layers.ageMs)} ms`
          : "暂无同帧结果";
    context!.fillStyle = "rgba(0,0,0,.75)";
    context!.fillRect(Math.max(0, canvas.width - 130), 0, 130, 24);
    context!.fillStyle = "white";
    context!.fillText(label, Math.max(5, canvas.width - 124), 16);
    notify();
  }
  function tick() {
    if (closed) return;
    const now = performance.now();
    if (!frozen) {
      let next: typeof displayed;
      while (
        frames[0] &&
        now - frames[0].availableAt >= presentationLimits.delayMs
      ) {
        if (next) {
          release(next);
        }
        next = frames.shift();
      }
      if (next) {
        if (displayed) release(displayed);
        displayed = next;
        chooseLayers();
        draw();
      }
      if (
        displayed &&
        now - displayed.availableAt > presentationLimits.inputSilenceMs &&
        layers.matching !== "none"
      ) {
        emptyLayers();
        draw();
      }
    }
    callback = requestAnimationFrame(tick);
  }
  callback = requestAnimationFrame(tick);
  return {
    revoke() {
      clearQueue();
      if (displayed) release(displayed);
      displayed = undefined;
      results.clear();
      runId = undefined;
      generation = undefined;
      active = false;
      frozen = false;
      emptyLayers();
      draw();
    },
    capture(input: Input) {
      if (closed || frozen || document.visibilityState !== "visible") return;
      const timestamp = input.rtpTimestamp;
      if (generation !== input.media.generation || timestamp < lastTimestamp) {
        clearQueue();
        results.clear();
        active = false;
        if (displayed) {
          release(displayed);
          displayed = undefined;
        }
        generation = input.media.generation;
        lastTimestamp = -1;
        emptyLayers();
      }
      if (timestamp === lastTimestamp) return;
      lastTimestamp = timestamp;
      try {
        // WebCodecs carries the source RTP identity through decoding.
        // Continuous presentation and freeze use this same immutable bitmap.
        const frame = input.frame;
        const scale = Math.min(
          1,
          presentationLimits.maxWidth / frame.displayWidth,
          presentationLimits.maxHeight / frame.displayHeight,
        );
        pixels.width = Math.max(1, Math.round(frame.displayWidth * scale));
        pixels.height = Math.max(1, Math.round(frame.displayHeight * scale));
        const size = pixels.width * pixels.height * 4;
        while (
          frames.length &&
          (frames.length + Number(!!displayed) >=
            presentationLimits.maxFrames ||
            bytes + size > presentationLimits.maxBytes)
        ) {
          release(frames.shift()!);
        }
        if (bytes + size > presentationLimits.maxBytes) {
          return;
        }
        pixelContext.drawImage(frame, 0, 0, pixels.width, pixels.height);
        const id = key(input.media.generation, timestamp);
        frames.push({
          id,
          generation: input.media.generation,
          rtpTimestamp: timestamp,
          bitmap: pixels.transferToImageBitmap(),
          availableAt: input.availableAt,
          bytes: size,
          originalWidth: frame.displayWidth,
          originalHeight: frame.displayHeight,
        });
        bytes += size;
      } catch (error) {
        failure = String(error);
        clearQueue();
        notify();
      }
    },
    update(source: Source | undefined) {
      if (closed || frozen) return;
      let changedLayers = false;
      const nextRun = source?.run?.runId;
      if (nextRun !== runId) {
        changedLayers = true;
        results.clear();
        runId = nextRun;
        emptyLayers();
      }
      active =
        !!source?.run &&
        source.status !== "unavailable" &&
        source.status !== "failed";
      if (!active) {
        results.clear();
        emptyLayers();
        draw();
        return;
      }
      const detection =
        source?.validity === "valid" ? source.observation : null;
      const tracking =
        source?.trackingValidity === "valid" ? source.tracking : null;
      for (const [kind, result] of [
        ["detection", detection],
        ["tracking", tracking],
      ] as const) {
        if (
          !result ||
          result.run.runId !== runId ||
          result.mediaTime.generation !== generation
        )
          continue;
        const id = key(
          result.mediaTime.generation,
          result.mediaTime.rtpTimestamp,
        );
        const previous = results.get(id) ?? { detection: null, tracking: null };
        if (previous[kind]) continue;
        results.set(id, { ...previous, [kind]: result });
        changedLayers = true;
      }
      while (results.size > presentationLimits.maxResults)
        results.delete(results.keys().next().value!);
      if (changedLayers && displayed) {
        chooseLayers();
        draw();
      }
    },
    suspend() {
      active = false;
      clearQueue();
      results.clear();
      if (!frozen) {
        emptyLayers();
        draw();
      }
    },
    freeze() {
      if (frozen || !displayed) return;
      frozen = true;
      frozenRun = runId;
      clearQueue();
      emptyLayers();
      chooseLayers();
      draw();
    },
    live() {
      frozen = false;
      clearQueue();
      if (displayed) {
        release(displayed);
        displayed = undefined;
      }
      emptyLayers();
      draw();
    },
    inspect() {
      return {
        frame: displayed
          ? {
              generation: displayed.generation,
              rtpTimestamp: displayed.rtpTimestamp,
              width: displayed.originalWidth,
              height: displayed.originalHeight,
            }
          : null,
        frozen,
        matching: layers.matching,
        ageMs: layers.ageMs,
        detection: layers.detection,
        tracking: layers.tracking,
      };
    },
    snapshot() {
      return { hasFrame: !!displayed, frozen, failure };
    },
    close() {
      closed = true;
      cancelAnimationFrame(callback);
      clearQueue();
      if (displayed) release(displayed);
      displayed = undefined;
      results.clear();
      pixels.width = 1;
      pixels.height = 1;
    },
  };
}
