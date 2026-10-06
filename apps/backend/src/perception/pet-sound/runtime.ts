import type { z } from "zod";
import type {
  audioRunSchema,
  petSoundAnalysisSchema,
  petSoundObservationSchema,
} from "@home-agent/api/contracts";
import { createAudioInferenceProcess } from "../audio/inference-process";
import { createPetSoundTrack } from "./track";
import { petSoundPolicy } from "./limits";
import { petSoundModelSha256 } from "./model";
import { petSoundResultSchema, petSoundJobSchema } from "./protocol";
import { selectPetSounds } from "./detections";

export function createPetSoundRuntime(options: {
  threshold: number;
  update: (runId: string, view: z.infer<typeof petSoundAnalysisSchema>) => void;
  deliver: (
    observation: z.infer<typeof petSoundObservationSchema>,
  ) => Promise<void>;
  fatal: (error: unknown) => void;
}) {
  const tracks = new Map<string, ReturnType<typeof createTrack>>();
  const queue = new Map<
    string,
    Parameters<Parameters<typeof createPetSoundTrack>[0]["segment"]>[0] & {
      run: z.infer<typeof audioRunSchema>;
      generation: string;
      queuedAt: number;
    }
  >();
  let worker:
    | ReturnType<
        typeof createAudioInferenceProcess<z.infer<typeof petSoundResultSchema>>
      >
    | undefined;
  let operation: Promise<void> | undefined;
  let closed = false;
  let failure: string | undefined;
  let failures = 0;
  let nextLoadAt = 0;
  let inFlight: string | undefined;
  let interrupted = false;
  function createTrack(run: z.infer<typeof audioRunSchema>) {
    let generation: string | undefined;
    let unavailable = false;
    const view: z.infer<typeof petSoundAnalysisSchema> = {
      status: "insufficient_input",
      modelSha256: petSoundModelSha256,
      chunks: [],
      dropped: 0,
      validity: "no_data",
    };
    function modelFailure(error: unknown) {
      view.status = "unavailable";
      view.error = String(error).slice(0, 4096);
      options.update(run.trackRunId, { ...view });
    }
    function fail(error: unknown) {
      unavailable = true;
      view.validity = "unavailable";
      view.chunks = [];
      modelFailure(error);
      cancel(run.trackRunId);
    }
    function drop() {
      view.dropped++;
      options.update(run.trackRunId, { ...view });
    }
    const track = createPetSoundTrack({
      segment(segment) {
        if (!generation)
          throw new Error("Pet sound evidence has no media clock");
        if (failures >= petSoundPolicy.maxFailures) {
          drop();
          return;
        }
        // One replaceable pending context per authorized source, plus one in flight.
        if (queue.has(run.trackRunId)) drop();
        queue.set(run.trackRunId, {
          ...segment,
          run,
          generation,
          queuedAt: performance.now(),
        });
        kick();
      },
    });
    return {
      modelFailure,
      drop,
      retry() {
        if (unavailable) return;
        view.status = view.chunks.length ? "ready" : "insufficient_input";
        delete view.error;
        options.update(run.trackRunId, { ...view });
      },
      get available() {
        return !unavailable;
      },
      media(value: string) {
        if (generation && generation !== value)
          fail("Pet sound media generation changed");
        else generation = value;
      },
      accept(pcm: Int16Array, offset: number, observedAt: number) {
        if (unavailable || closed) return;
        try {
          track.accept(pcm, offset, observedAt);
        } catch (error) {
          fail(error);
        }
      },
      publish(observation: z.infer<typeof petSoundObservationSchema>) {
        view.status = "ready";
        delete view.error;
        view.validity =
          Date.now() - observation.observedEndAt < petSoundPolicy.resultAgeMs
            ? "valid"
            : "expired";
        view.chunks = [observation];
        options.update(run.trackRunId, { ...view });
      },
      start() {
        if (failure) modelFailure(failure);
        else options.update(run.trackRunId, { ...view });
      },
    };
  }
  async function drive() {
    try {
      if (worker?.status.error) throw worker.status.error;
      if (!worker) {
        worker = createAudioInferenceProcess({
          entry: new URL(
            import.meta.url.endsWith(".ts")
              ? "./process-entry.ts"
              : "../pet-sound/process-entry.js",
            import.meta.url,
          ),
          result: petSoundResultSchema,
          job: petSoundJobSchema,
          modelSha256: petSoundModelSha256,
          limits: petSoundPolicy,
        });
        await worker.initialize();
        failure = undefined;
        for (const track of tracks.values()) track.retry();
      }
      while (queue.size) {
        if (closed) break;
        const [runId, job] = queue.entries().next().value!;
        queue.delete(runId);
        const track = tracks.get(runId);
        if (!track?.available) continue;
        if (performance.now() - job.queuedAt > petSoundPolicy.queueAgeMs) {
          track.drop();
          continue;
        }
        const id = `${runId}:${job.startSample}:${job.endSample}`;
        inFlight = runId;
        const result = await worker.evaluate({ id, samples: job.samples });
        inFlight = undefined;
        if (closed || tracks.get(runId) !== track || !track.available) continue;
        const { samples: _samples, queuedAt: _queuedAt, ...interval } = job;
        const observation = {
          ...interval,
          id,
          completedAt: Date.now(),
          modelSha256: petSoundModelSha256,
          processingVersion: "zipformer-pet-overlap" as const,
          inferenceMs: result.elapsedMs,
          detections: selectPetSounds(result.events, options.threshold),
        };
        await options.deliver(observation);
        if (!closed && tracks.get(runId) === track && track.available)
          track.publish(observation);
      }
    } catch (error) {
      if (!closed && !interrupted) {
        failures++;
        failure = String(error).slice(0, 4096);
        if (inFlight) tracks.get(inFlight)?.drop();
        for (const track of tracks.values())
          if (track.available) track.modelFailure(error);
        if (failures >= petSoundPolicy.maxFailures) {
          for (const runId of queue.keys()) tracks.get(runId)?.drop();
          queue.clear();
        }
        nextLoadAt = performance.now() + petSoundPolicy.recoveryDelayMs;
      }
      await worker?.close();
      worker = undefined;
    } finally {
      if (interrupted || !tracks.size) {
        await worker?.close();
        worker = undefined;
      }
      inFlight = undefined;
      interrupted = false;
    }
  }
  function kick() {
    if (
      operation ||
      closed ||
      failures >= petSoundPolicy.maxFailures ||
      performance.now() < nextLoadAt ||
      (!queue.size && !worker?.status.error)
    )
      return;
    operation = drive()
      .catch(options.fatal)
      .finally(() => {
        operation = undefined;
        if (queue.size && !closed) kick();
      });
  }
  function cancel(runId: string) {
    queue.delete(runId);
    if (
      worker &&
      (inFlight === runId ||
        ![...tracks.values()].some((track) => track.available))
    ) {
      interrupted = true;
      worker.interrupt();
      if (!operation) {
        operation = worker
          .close()
          .then(() => {
            worker = undefined;
          })
          .catch(options.fatal)
          .finally(() => {
            operation = undefined;
            interrupted = false;
            if (queue.size && !closed) kick();
          });
      }
    }
  }
  const timer = setInterval(kick, 250);
  return {
    start(run: z.infer<typeof audioRunSchema>) {
      if (closed || tracks.size >= 8 || tracks.has(run.trackRunId))
        throw new Error("Pet sound track capacity exceeded");
      const track = createTrack(run);
      tracks.set(run.trackRunId, track);
      track.start();
    },
    media(runId: string, generation: string) {
      tracks.get(runId)?.media(generation);
    },
    accept(runId: string, pcm: Int16Array, offset: number, observedAt: number) {
      tracks.get(runId)?.accept(pcm, offset, observedAt);
    },
    end(runId: string) {
      tracks.delete(runId);
      cancel(runId);
    },
    retry() {
      if (closed) return;
      failures = 0;
      nextLoadAt = 0;
      failure = undefined;
      for (const track of tracks.values()) track.retry();
      kick();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      tracks.clear();
      queue.clear();
      await worker?.close();
      await operation;
    },
  };
}
