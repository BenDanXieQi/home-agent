import { petSoundPolicy } from "./limits";

export function createPetSoundTrack(options: {
  segment: (value: {
    samples: Float32Array;
    startSample: number;
    endSample: number;
    observedStartAt: number;
    observedEndAt: number;
  }) => void;
}) {
  const buffer = new Float32Array(petSoundPolicy.contextMs * 16);
  const hop = petSoundPolicy.hopMs * 16;
  let count = 0;
  let nextSample = 0;
  let anchor: number | undefined;
  return {
    accept(pcm: Int16Array, offset: number, observedAt: number) {
      const origin = observedAt - offset / 16;
      anchor ??= origin;
      if (offset !== nextSample || Math.abs(origin - anchor) > 2)
        throw new Error("Pet sound source clock discontinuity");
      nextSample += pcm.length;
      let cursor = 0;
      while (cursor < pcm.length) {
        const size = Math.min(pcm.length - cursor, buffer.length - count);
        for (let i = 0; i < size; i++)
          buffer[count + i] = pcm[cursor + i]! / 32768;
        count += size;
        cursor += size;
        if (count === buffer.length) {
          options.segment({
            samples: buffer.slice(),
            startSample: offset + cursor - count,
            endSample: offset + cursor,
            observedStartAt: anchor + (offset + cursor - count) / 16,
            observedEndAt: anchor + (offset + cursor) / 16,
          });
          buffer.copyWithin(0, hop);
          count -= hop;
        }
      }
    },
  };
}
