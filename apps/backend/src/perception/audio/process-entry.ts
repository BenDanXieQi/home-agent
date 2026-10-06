import { createPetSoundRuntime } from "../pet-sound/runtime";
import pTimeout from "p-timeout";
import { createSpeechRuntime } from "../speech/runtime";
import type { speechTrackSchema } from "@home-agent/api/contracts";
import { createSileroTrack, createVad } from "./silero-vad";
import { createAudioAnalysis } from "./analysis";
import { createAudioDecoder } from "./decoder";
import { AudioTrackMissing } from "./encoded-stream";
import { readAudioStream } from "../../mijia/media/audio-stream";
import { audioCommandSchema, initialAudioTrack } from "./protocol";
import type { audioResponseSchema, audioStartSchema } from "./protocol";
import type { z } from "zod";

function send(message: z.infer<typeof audioResponseSchema>) {
  return new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("Audio IPC disconnected"));
      return;
    }
    process.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
let failed = false;
function fatal(error: unknown) {
  if (failed) return;
  failed = true;
  send({ kind: "fatal", error: String(error).slice(0, 4096) })
    .catch((flushError) => {
      console.error("Audio fatal publication failed", flushError);
    })
    .finally(() => process.exit(1));
}
let model: Awaited<ReturnType<typeof createVad>> | undefined;
let modelError: string | undefined;
try {
  model = await createVad();
} catch (error) {
  modelError = String(error).slice(0, 4096);
}
let inferenceSince: number | null = null;
// One shared CPU session and at most one pending call per bounded source decoder.
let inference = Promise.resolve();
function evaluate(input: Float32Array, state: Float32Array) {
  const task = inference.then(async () => {
    if (!model || modelError) throw new Error(modelError ?? "VAD unavailable");
    inferenceSince = Date.now();
    try {
      return await model.evaluate(input, state);
    } finally {
      inferenceSince = null;
    }
  });
  inference = task.then(
    () => {},
    (error) => {
      modelError = String(error).slice(0, 4096);
    },
  );
  return task;
}
const tracks = new Map<string, ReturnType<typeof createTrack>>();
let delivery:
  | { id: string; runId: string; resolve: (inboxAccepted: boolean) => void }
  | undefined;
let closing = false;
let speech: ReturnType<typeof createSpeechRuntime> | undefined;
let petSounds: ReturnType<typeof createPetSoundRuntime> | undefined;
const pulseTimer = setInterval(() => {
  send({ kind: "pulse", inferenceSince, speech: speech?.snapshot() }).catch(
    fatal,
  );
}, 250);
await send({
  kind: "ready",
  model: model?.metadata ?? null,
  error: modelError,
});
async function handleCommand(message: unknown) {
  const command = audioCommandSchema.parse(message);
  if (command.kind === "speech_ack") {
    if (delivery?.id === command.id) delivery.resolve(command.inboxAccepted);
    return;
  }
  if (command.kind === "close") {
    delivery?.resolve(false);
    closing = true;
    clearInterval(pulseTimer);
    await closeTracks();
    await speech?.close();
    await petSounds?.close();
    await inference;
    await model?.close();
    await send({ kind: "closed" });
    process.exit(0);
    return;
  }
  if (closing) return;
  if (command.kind === "retry_analysis") {
    speech?.retry();
    petSounds?.retry();
    return;
  }
  if (command.kind === "stop") {
    const entry = tracks.get(command.trackRunId);
    if (entry) {
      entry.stopped = true;
      if (delivery?.runId === command.trackRunId) delivery.resolve(false);
      speech?.end(command.trackRunId);
      petSounds?.end(command.trackRunId);
      await entry.decoder.close();
      tracks.delete(command.trackRunId);
    }
    await send({ kind: "stopped", trackRunId: command.trackRunId });
    return;
  }
  const { input } = command;
  if (tracks.size >= 8 || tracks.has(input.run.trackRunId))
    throw new Error("Audio track capacity exceeded");
  if (input.config.speech.enabled && !speech) {
    speech = createSpeechRuntime({
      config: input.config.speech,
      fatal,
      async deliver(observation) {
        const pending = Promise.withResolvers<boolean>();
        delivery = {
          id: observation.id,
          runId: observation.run.trackRunId,
          resolve: pending.resolve,
        };
        try {
          await send({ kind: "speech", observation });
          return await pTimeout(pending.promise, {
            milliseconds: 1000,
            fallback: () => false,
          });
        } catch (error) {
          fatal(error);
          return false;
        } finally {
          delivery = undefined;
        }
      },
      update(runId, value) {
        tracks.get(runId)?.updateSpeech(value);
      },
    });
  }
  if (input.config.petSounds.enabled && !petSounds) {
    petSounds = createPetSoundRuntime({
      threshold: input.config.petSounds.threshold,
      fatal,
      deliver: (observation) => send({ kind: "pet_sound", observation }),
      update(runId, value) {
        tracks.get(runId)?.updatePetSounds(value);
      },
    });
  }
  tracks.set(input.run.trackRunId, createTrack(input));
  if (input.config.speech.enabled) speech?.start(input.run);
  if (input.config.petSounds.enabled) petSounds?.start(input.run);
}

function createTrack(input: z.infer<typeof audioStartSchema>) {
  let view = initialAudioTrack(input);
  let origin = 0;
  const analysis = createAudioAnalysis(
    createSileroTrack(
      model ? evaluate : undefined,
      input.config.speech.enabled
        ? async (block, samples) => {
            if (!entry.stopped && !closing)
              await speech?.accept(
                input.run.trackRunId,
                block,
                samples,
                origin,
              );
          }
        : undefined,
    ),
  );
  const entry = {
    stopped: false,
    updatePetSounds(
      value: Parameters<
        Parameters<typeof createPetSoundRuntime>[0]["update"]
      >[1],
    ) {
      if (entry.stopped || closing) return;
      view = { ...view, petSounds: value };
      send({ kind: "track", track: view }).catch(fatal);
    },
    updateSpeech(value: z.infer<typeof speechTrackSchema>) {
      if (entry.stopped || closing) return;
      view = { ...view, speech: value };
      send({ kind: "track", track: view }).catch(fatal);
    },
    decoder: createAudioDecoder({
      config: input.config,
      executable: input.executable,
      open: (signal) => readAudioStream(input.access, signal),
      onMedia(media) {
        view = { ...view, ...media };
        speech?.media(input.run.trackRunId, media.generation);
        petSounds?.media(input.run.trackRunId, media.generation);
      },
      async onPcm(pcm, observedAt, receivedAt) {
        origin = observedAt - view.samples / 16;
        const result = await analysis.accept(pcm);
        if (entry.stopped || closing) return;
        if (result.vadStatus === "unavailable")
          speech?.unavailable(
            input.run.trackRunId,
            result.vadError ?? modelError ?? "VAD unavailable",
          );
        if (Date.now() - observedAt > input.config.maxFrameAgeMs)
          throw new Error("Audio analysis exceeded maximum media age");
        view = {
          ...view,
          ...result,
          status: "reading",
          validity: "valid",
          receivedAt,
          observedAt,
          sequence: view.sequence + 1,
          vadError: result.vadError ?? modelError,
        };
        await send({ kind: "track", track: view, pcm });
        if (!entry.stopped && !closing)
          petSounds?.accept(
            input.run.trackRunId,
            pcm,
            view.samples - pcm.length,
            observedAt,
          );
      },
    }),
  };
  entry.decoder.completed
    .catch(async (error: unknown) => {
      if (entry.stopped || closing) return;
      speech?.end(input.run.trackRunId);
      petSounds?.end(input.run.trackRunId);
      view = {
        ...view,
        status: error instanceof AudioTrackMissing ? "no_track" : "failed",
        error: String(error).slice(0, 4096),
        validity: "unavailable",
        energy: [],
        vad: [],
        vadStatus: "unavailable",
        petSounds: view.petSounds && {
          ...view.petSounds,
          status: "unavailable",
          validity: "unavailable",
          chunks: [],
        },
        energyRemainder: 0,
        vadRemainder: 0,
        speech: view.speech && {
          ...view.speech,
          status: "unavailable",
          validity: "unavailable",
        },
      };
      await send({ kind: "track", track: view });
    })
    .catch(fatal);
  return entry;
}

async function closeTracks() {
  await Promise.all(
    [...tracks.values()].map((entry) => {
      entry.stopped = true;
      return entry.decoder.close();
    }),
  );
  tracks.clear();
}

process.on("message", (message: unknown) => {
  handleCommand(message).catch(fatal);
});
process.on("disconnect", () => {
  // No native thread termination: stop decoder children before leaving the owner.
  closing = true;
  delivery?.resolve(false);
  clearInterval(pulseTimer);
  Promise.all([speech?.close(), petSounds?.close(), closeTracks()]).then(
    () => process.exit(0),
    (error) => {
      console.error("Audio orphan cleanup failed", error);
      process.exit(1);
    },
  );
});
