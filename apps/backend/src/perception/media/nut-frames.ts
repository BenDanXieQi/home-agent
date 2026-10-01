import type { Readable } from "node:stream";
import { Demuxer } from "node-av/api";
import { AV_CODEC_ID_RAWVIDEO, AV_PIX_FMT_RGB24 } from "node-av/constants";
import { frameLimits } from "../detection/frame";

// FFmpeg owns decoding and sampling in its isolated process. libavformat owns
// container parsing; each raw packet carries its own PTS and complete pixels.
export async function* readNutFrames(input: Readable, signal: AbortSignal) {
  await using demuxer = await Demuxer.open(input, {
    format: "nut",
    copyTs: true,
    options: { probesize: 32, analyzeduration: 1, fpsprobesize: 0 },
    signal,
  });
  const video = demuxer.video();
  if (
    !video ||
    video.codecpar.codecId !== AV_CODEC_ID_RAWVIDEO ||
    video.codecpar.format !== AV_PIX_FMT_RGB24 ||
    video.timeBase.num !== 1 ||
    video.timeBase.den !== 90000
  )
    throw new Error("Expected RGB24 frames with a 90 kHz media clock");
  const { width, height } = video.codecpar;
  if (
    width <= 0 ||
    height <= 0 ||
    width > frameLimits.maxDimension ||
    height > frameLimits.maxDimension ||
    width * height > frameLimits.maxPixels
  )
    throw new Error("Decoded frame exceeds pixel budget");
  let previous = -1;
  for await (const packet of demuxer.packets(video.index)) {
    if (!packet) break;
    try {
      signal.throwIfAborted();
      const pts = Number(packet.pts);
      if (
        !Number.isSafeInteger(pts) ||
        pts < 0 ||
        pts > 0xffffffff ||
        pts <= previous ||
        packet.size !== width * height * 3 ||
        !packet.data
      )
        throw new Error("Invalid RGB24 frame size or media timestamp");
      previous = pts;
      // The inference worker takes ownership of this JS buffer after the native
      // packet is released; do not expose native memory to the transfer list.
      yield { width, height, rgb: Uint8Array.from(packet.data), pts };
    } finally {
      packet.free();
    }
  }
}
