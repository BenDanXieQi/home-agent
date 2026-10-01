import { Readable } from "node:stream";
import { Demuxer, Decoder, FilterAPI } from "node-av/api";
import { AV_SAMPLE_FMT_S16 } from "node-av/constants";
import type { createAudioDecoder } from "../../src/perception/audio/decoder";

// Benchmark alternative only. It intentionally has the same PCM and time contract,
// but a native failure here shares the VAD process rather than one FFmpeg child.
export function createLibavAudioDecoder(
  options: Parameters<typeof createAudioDecoder>[0],
) {
  const stopped = new AbortController();
  const completed = (async () => {
    const input = await options.open(stopped.signal);
    options.onMedia({
      generation: input.generation,
      anchorReceivedAt: input.anchorReceivedAt,
      decodedStartOffsetMs: input.decodedStartOffsetMs,
    });
    await using demuxer = await Demuxer.open(Readable.fromWeb(input.stream), {
      format: input.format,
      signal: stopped.signal,
      options: {
        probesize: 32,
        analyzeduration: 1,
        ...(input.format === "alaw"
          ? { sample_rate: 8000, ch_layout: "mono" }
          : {}),
      },
    });
    const stream = demuxer.audio();
    if (!stream) throw new Error("No audio stream");
    using decoder = await Decoder.create(stream, {
      context: { threadCount: 1 },
      signal: stopped.signal,
    });
    using filter = FilterAPI.create(
      "aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono,asetnsamples=n=512:p=0",
      { graph: { nbThreads: 1 }, signal: stopped.signal },
    );
    let firstPts: bigint | undefined;
    for await (const frame of filter.frames(
      decoder.frames(demuxer.packets(stream.index)),
    )) {
      if (!frame) break;
      try {
        if (
          frame.format !== AV_SAMPLE_FMT_S16 ||
          frame.sampleRate !== 16000 ||
          frame.channels !== 1
        )
          throw new Error("Unexpected PCM output");
        const data = frame.data?.[0];
        if (!data) throw new Error("Missing decoded samples");
        const pcm = new Int16Array(frame.nbSamples);
        for (let index = 0; index < pcm.length; index++)
          pcm[index] = data.readInt16LE(index * 2);
        firstPts ??= frame.pts;
        const observedAt =
          input.anchorReceivedAt +
          input.decodedStartOffsetMs +
          (Number(frame.pts - firstPts) * frame.timeBase.num * 1000) /
            frame.timeBase.den;
        if (Math.abs(Date.now() - observedAt) > options.config.maxFrameAgeMs)
          throw new Error("Decoded audio is outside the media age budget");
        await options.onPcm(pcm, observedAt, Date.now());
      } finally {
        frame.free();
      }
    }
  })();
  return {
    completed,
    async close() {
      stopped.abort();
      await Promise.allSettled([completed]);
    },
  };
}
