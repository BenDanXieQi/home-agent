import { pcmSchema } from "./pcm";
import { z } from "zod";
import {
  audioRunSchema,
  audioTrackSchema,
  speechRuntimeSchema,
  speechObservationSchema,
} from "@home-agent/api/contracts";
import { sourceAccessSchema } from "../sources";
import { perceptionConfigSchema } from "../config";
export const audioStartSchema = z.object({
  run: audioRunSchema,
  access: sourceAccessSchema,
  executable: z.string().min(1),
  config: perceptionConfigSchema,
  channels: audioTrackSchema.shape.channels,
});
export const audioCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), input: audioStartSchema }),
  z.object({ kind: z.literal("stop"), trackRunId: z.uuid() }),
  z.object({ kind: z.literal("close") }),
  z.object({ kind: z.literal("retry_speech") }),
  z.object({
    kind: z.literal("speech_ack"),
    id: speechObservationSchema.shape.id,
    accepted: z.boolean(),
  }),
]);
export const audioResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    model: z
      .object({ sha256: z.string(), provider: z.literal("cpu") })
      .nullable(),
    error: z.string().max(4096).optional(),
  }),
  z.object({
    kind: z.literal("pulse"),
    inferenceSince: z.number().nullable(),
    speech: speechRuntimeSchema.optional(),
  }),
  z.object({
    kind: z.literal("track"),
    track: audioTrackSchema,
    pcm: pcmSchema.optional(),
  }),
  z.object({ kind: z.literal("speech"), observation: speechObservationSchema }),
  z.object({ kind: z.literal("stopped"), trackRunId: z.uuid() }),
  z.object({ kind: z.literal("closed") }),
  z.object({ kind: z.literal("fatal"), error: z.string().max(4096) }),
]);
export function initialAudioTrack(
  input: Pick<z.infer<typeof audioStartSchema>, "run" | "channels">,
) {
  return audioTrackSchema.parse({
    ...input,
    status: "starting",
    generation: null,
    anchorReceivedAt: null,
    decodedStartOffsetMs: 0,
    timeQuality: "host_receive_anchor",
    synchronizationAccuracyMs: null,
    sampleRate: 16000,
    receivedAt: null,
    observedAt: null,
    sequence: 0,
    samples: 0,
    energy: [],
    vad: [],
    vadStatus: "insufficient_input",
    energyRemainder: 0,
    vadRemainder: 0,
    validity: "no_data",
  });
}
