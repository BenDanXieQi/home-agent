import pTimeout from "p-timeout";
import { createSpeechRuntime } from "../speech/runtime";
import type { speechTrackSchema } from "@home-agent/api/contracts";
import { createSileroTrack, createVad } from "./silero-vad";
import { createAudioAnalysis } from "./analysis";
import { createAudioDecoder } from "./decoder";
import { AudioTrackMissing } from "./encoded-stream";
import { readAudioStream } from "../../mijia/media/audio-stream";
import { audioCommandSchema, initialAudioTrack } from "./protocol";
import type { audioResponseSchema } from "./protocol";
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
    .finally(() => process.exit(1))
    .catch((flushError) => {
      console.error("Audio fatal publication failed", flushError);
    });
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
const tracks = new Map<
  string,
  {
    decoder: ReturnType<typeof createAudioDecoder>;
    stopped: boolean;
    updateSpeech: (view: z.infer<typeof speechTrackSchema>) => void;
  }
>();
let delivery:
  | { id: string; runId: string; resolve: (accepted: boolean) => void }
  | undefined;
let closing = false;
let speech: ReturnType<typeof createSpeechRuntime> | undefined;
const pulseTimer = setInterval(() => {
  send({ kind: "pulse", inferenceSince, speech: speech?.snapshot() }).catch(
    fatal,
  );
}, 250);
await send({
  kind: "ready",
  model: model ? { sha256: model.metadata.sha256, provider: "cpu" } : null,
  error: modelError,
});
process.on("message", (message: unknown) => {
  Promise.resolve()
    .then(async () => {
      const command = audioCommandSchema.parse(message);
      if (command.kind === "speech_ack") {
        if (delivery?.id === command.id) delivery.resolve(command.accepted);
        return;
      }
      if (command.kind === "close") {
        delivery?.resolve(false);
        closing = true;
        clearInterval(pulseTimer);
        await Promise.all(
          [...tracks.values()].map(async (entry) => {
            entry.stopped = true;
            await entry.decoder.close();
          }),
        );
        tracks.clear();
        await speech?.close();
        await inference;
        await model?.close();
        await send({ kind: "closed" });
        process.exit(0);
        return;
      }
      if (closing) return;
      if (command.kind === "retry_speech") {
        speech?.retry();
        return;
      }
      if (command.kind === "stop") {
        const entry = tracks.get(command.trackRunId);
        if (entry) {
          entry.stopped = true;
          if (delivery?.runId === command.trackRunId) delivery.resolve(false);
          speech?.end(command.trackRunId);
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
            await send({ kind: "track", track: view });
          },
        }),
      };
      tracks.set(input.run.trackRunId, entry);
      if (input.config.speech.enabled) speech?.start(input.run);
      entry.decoder.completed
        .catch(async (error: unknown) => {
          if (entry.stopped || closing) return;
          speech?.end(input.run.trackRunId);
          view = {
            ...view,
            status: error instanceof AudioTrackMissing ? "no_track" : "failed",
            error: String(error).slice(0, 4096),
            validity: "unavailable",
            energy: [],
            vad: [],
            vadStatus: "unavailable",
            energyRemainder: 0,
            vadRemainder: 0,
            ...(view.speech
              ? {
                  speech: {
                    ...view.speech,
                    status: "unavailable",
                    validity: "unavailable",
                  },
                }
              : {}),
          };
          await send({ kind: "track", track: view });
        })
        .catch(fatal);
    })
    .catch(fatal);
});
process.on("disconnect", () => {
  // No native thread termination: stop decoder children before leaving the owner.
  closing = true;
  delivery?.resolve(false);
  clearInterval(pulseTimer);
  Promise.all([
    speech?.close(),
    ...[...tracks.values()].map(async (entry) => {
      entry.stopped = true;
      await entry.decoder.close();
    }),
  ]).then(
    () => process.exit(0),
    (error) => {
      console.error("Audio orphan cleanup failed", error);
      process.exit(1);
    },
  );
});
