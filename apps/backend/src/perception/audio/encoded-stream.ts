import { z } from "zod";

export const encodedAudioSchema = z.object({
  format: z.enum(["alaw", "ogg"]),
  generation: z.uuid(),
  anchorReceivedAt: z.number().int().positive(),
  decodedStartOffsetMs: z.number().nonnegative().max(1000),
});

export class AudioTrackMissing extends Error {}
