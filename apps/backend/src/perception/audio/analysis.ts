import type { z } from "zod";
import type { audioTrackSchema } from "@home-agent/api/contracts";

export type SpeechAnalysis = {
  accept: (
    pcm: Int16Array,
    startSample: number,
  ) => Promise<{
    blocks: Omit<
      z.infer<typeof audioTrackSchema>["vad"][number],
      "aboveThreshold"
    >[];
    remainder: number;
    status: z.infer<typeof audioTrackSchema>["vadStatus"];
    error: string | undefined;
  }>;
};

export function createAudioAnalysis(speech: SpeechAnalysis) {
  let energyCount = 0,
    energySquares = 0,
    samples = 0;
  return {
    async accept(pcm: Int16Array) {
      const startSample = samples;
      const energy: z.infer<typeof audioTrackSchema>["energy"] = [];
      for (const value of pcm) {
        energySquares += value * value;
        energyCount++;
        samples++;
        if (energyCount === 480) {
          const rms = Math.sqrt(energySquares / 480) / 32768;
          energy.push({
            startSample: samples - 480,
            endSample: samples,
            rms,
            active: rms >= 0.015,
          });
          energyCount = 0;
          energySquares = 0;
        }
      }
      const result = await speech.accept(pcm, startSample);
      return {
        samples,
        energy,
        vad: result.blocks.map((block) => ({
          ...block,
          aboveThreshold: block.probability >= 0.4,
        })),
        energyRemainder: energyCount,
        vadRemainder: result.remainder,
        vadStatus: result.status,
        vadError: result.error,
      };
    },
  };
}
