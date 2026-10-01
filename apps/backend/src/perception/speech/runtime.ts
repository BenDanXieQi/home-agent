import { z } from "zod";
import {
  audioRunSchema,
  speechConfigSchema,
  speechObservationSchema,
  speechTrackSchema,
  speechRuntimeSchema,
} from "@home-agent/api/contracts";
import { createUtterances } from "./utterance";
import { createSpeechProcess } from "./process";
import { senseVoiceModel, speechLimits } from "./limits";
import { speechJobSchema } from "./protocol";

const taskSchema = speechObservationSchema
  .omit({
    text: true,
    completedAt: true,
    modelSha256: true,
    processingVersion: true,
    inferenceMs: true,
  })
  .extend({
    samples: speechJobSchema.shape.samples,
    queuedAt: z.number(),
  });

// Lives exclusively in audio/process-entry; only small validated views leave that process.
export function createSpeechRuntime(options: {
  config: z.infer<typeof speechConfigSchema>;
  update: (runId: string, view: z.infer<typeof speechTrackSchema>) => void;
  fatal: (error: unknown) => void;
  deliver: (
    observation: z.infer<typeof speechObservationSchema>,
  ) => Promise<boolean>;
}) {
  const tracks = new Map<string, ReturnType<typeof createTrack>>();
  const queue: z.infer<typeof taskSchema>[] = [];
  let worker: ReturnType<typeof createSpeechProcess> | undefined;
  let interrupted: typeof worker;
  let operation: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false,
    warmRequested = false;
  let lastVoiceAt = 0,
    nextLoadAt = 0;
  let status: z.infer<typeof speechRuntimeSchema>["status"] = "sleeping";
  let lastError: string | undefined;
  let loads = 0,
    failures = 0,
    completed = 0,
    dropped = 0,
    cancelled = 0,
    handoffRejected = 0;
  let inFlight: z.infer<typeof taskSchema> | undefined;
  function publish(runId: string) {
    const track = tracks.get(runId);
    if (!track) return;
    track.view.status =
      track.failed || status === "unavailable"
        ? "unavailable"
        : inFlight?.run.trackRunId === runId
          ? "recognizing"
          : queue.some((job) => job.run.trackRunId === runId)
            ? "queued"
            : track.utterances.speaking
              ? "collecting"
              : "listening";
    if (!track.failed) {
      if (status === "unavailable") track.view.error = lastError;
      else delete track.view.error;
    }
    track.publish();
  }
  function publishAll() {
    for (const runId of tracks.keys()) publish(runId);
  }
  function drop(job: z.infer<typeof taskSchema>) {
    dropped++;
    const track = tracks.get(job.run.trackRunId);
    if (track) {
      track.view.dropped++;
      publish(job.run.trackRunId);
    }
  }
  function wake() {
    if (closed || failures >= speechLimits.maxFailures) return;
    lastVoiceAt = performance.now();
    warmRequested = true;
    kick();
  }
  function enqueue(job: z.infer<typeof taskSchema>) {
    if (closed || failures >= speechLimits.maxFailures) {
      drop(job);
      return;
    }
    const previous = queue.findIndex(
      (item) => item.run.trackRunId === job.run.trackRunId,
    );
    if (previous >= 0) {
      drop(queue[previous]!);
      queue[previous] = job;
    } else if (queue.length < speechLimits.pendingJobs) queue.push(job);
    else {
      drop(job);
      return;
    }
    wake();
    publish(job.run.trackRunId);
  }
  function createTrack(run: z.infer<typeof audioRunSchema>) {
    const view = speechTrackSchema.parse({
      status: "listening",
      latest: null,
      validity: "no_data",
      dropped: 0,
    });
    let published: typeof view | undefined;
    let generation: string | undefined,
      anchor: number | undefined,
      failed = false;
    const utterances = createUtterances({
      speech: wake,
      activity() {
        publish(run.trackRunId);
      },
      segment(segment) {
        if (generation === undefined || anchor === undefined)
          throw new Error("Speech evidence has no media clock");
        enqueue(
          taskSchema.parse({
            ...segment,
            samples: segment.samples,
            id: `${run.trackRunId}:${segment.startSample}:${segment.endSample}`,
            run,
            generation,
            observedStartAt: anchor + segment.startSample / 16,
            observedEndAt: anchor + segment.speechEndSample / 16,
            queuedAt: performance.now(),
          }),
        );
      },
    });
    return {
      run,
      view,
      utterances,
      get failed() {
        return failed;
      },
      publish() {
        if (
          published &&
          published.status === view.status &&
          published.latest === view.latest &&
          published.validity === view.validity &&
          published.dropped === view.dropped &&
          published.error === view.error
        )
          return;
        published = { ...view };
        options.update(run.trackRunId, published);
      },
      unavailable(reason: string) {
        if (failed) return;
        failed = true;
        utterances.reset();
        view.error = reason.slice(0, 4096);
        view.validity = "unavailable";
        publish(run.trackRunId);
      },
      media(value: string) {
        if (generation !== undefined && generation !== value) {
          unavailable(
            run.trackRunId,
            "Speech media generation changed within an audio run",
          );
          return;
        }
        generation = value;
      },
      async accept(
        block: Parameters<typeof utterances.accept>[0],
        samples: Float32Array,
        origin: number,
      ) {
        if (failed) return;
        try {
          anchor ??= origin;
          if (Math.abs(anchor - origin) > 2)
            throw new Error("Speech source clock discontinuity");
          await utterances.accept(block, samples);
          if (
            utterances.speaking &&
            block.probability >= speechLimits.positiveThreshold &&
            warmRequested
          )
            lastVoiceAt = performance.now();
        } catch (error) {
          unavailable(run.trackRunId, String(error));
        }
      },
    };
  }
  async function release() {
    const owned = worker;
    if (!owned) return;
    status = "unloading";
    publishAll();
    try {
      await owned.close();
    } catch (error) {
      options.fatal(error);
      throw error;
    }
    if (worker === owned) worker = undefined;
    if (interrupted === owned) interrupted = undefined;
  }
  async function recover(error: unknown, intentional: boolean) {
    if (!intentional) {
      failures++;
      lastError = String(error).slice(0, 4096);
    }
    await release();
    nextLoadAt = intentional
      ? 0
      : performance.now() + speechLimits.recoveryDelayMs;
    status = closed
      ? "closed"
      : failures >= speechLimits.maxFailures
        ? "unavailable"
        : intentional
          ? "sleeping"
          : "recovering";
    if (status === "unavailable") {
      warmRequested = false;
      for (const job of queue.splice(0)) drop(job);
    }
    publishAll();
  }
  async function drive() {
    if (closed) return;
    if (worker?.status.error)
      await recover(worker.status.error, worker === interrupted);
    if (closed) return;
    if (
      ![...tracks.values()].some((track) => !track.failed) ||
      (!queue.length &&
        performance.now() - lastVoiceAt >= options.config.idleUnloadMs)
    ) {
      warmRequested = false;
      await release();
      status =
        failures >= speechLimits.maxFailures ? "unavailable" : "sleeping";
      publishAll();
      return;
    }
    if (
      (!warmRequested && !queue.length) ||
      failures >= speechLimits.maxFailures ||
      performance.now() < nextLoadAt
    )
      return;
    try {
      if (!worker) {
        status = "loading";
        worker = createSpeechProcess();
        publishAll();
        await worker.initialize();
        if (closed) return;
        loads++;
        status = "ready";
        lastError = undefined;
        publishAll();
      }
      while (queue.length) {
        if (closed) break;
        const workerError = worker.status.error;
        if (workerError) throw workerError;
        const job = queue.shift()!;
        if (!tracks.has(job.run.trackRunId)) {
          cancelled++;
          continue;
        }
        if (performance.now() - job.queuedAt > speechLimits.queueAgeMs) {
          drop(job);
          continue;
        }
        inFlight = job;
        status = "recognizing";
        publish(job.run.trackRunId);
        const result = await worker.recognize(job);
        // Delivery no longer owns a native inference that source revocation must interrupt.
        inFlight = undefined;
        status = "ready";
        const track = tracks.get(job.run.trackRunId);
        if (!closed && track && !track.failed) {
          track.view.latest = speechObservationSchema.parse({
            ...job,
            text: result.text,
            completedAt: Date.now(),
            inferenceMs: result.elapsedMs,
            modelSha256: senseVoiceModel.sha256,
            processingVersion: senseVoiceModel.processingVersion,
          });
          track.view.validity =
            Date.now() - job.observedEndAt < speechLimits.resultAgeMs
              ? "valid"
              : "expired";
          completed++;
          if (!(await options.deliver(track.view.latest))) handoffRejected++;
        } else cancelled++;
        publish(job.run.trackRunId);
      }
    } catch (error) {
      const intentional =
        (worker !== undefined && worker === interrupted) || closed;
      if (inFlight) {
        if (intentional) cancelled++;
        else drop(inFlight);
      }
      inFlight = undefined;
      await recover(error, intentional);
    }
  }
  function kick() {
    if (operation || closed) return;
    operation = drive()
      .catch((error: unknown) => {
        status = "unavailable";
        lastError = String(error).slice(0, 4096);
        publishAll();
      })
      .finally(() => {
        operation = undefined;
      });
  }
  const timer = setInterval(kick, 250);
  function end(runId: string) {
    const track = tracks.get(runId);
    if (!track) return;
    track.utterances.reset();
    tracks.delete(runId);
    cancel(runId);
  }
  function unavailable(runId: string, reason: string) {
    const track = tracks.get(runId);
    if (!track || track.failed) return;
    track.unavailable(reason);
    cancel(runId);
  }
  function cancel(runId: string) {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i]!.run.trackRunId === runId) {
        queue.splice(i, 1);
        cancelled++;
      }
    }
    const hasAvailableTracks = [...tracks.values()].some(
      (item) => !item.failed,
    );
    if (!hasAvailableTracks) warmRequested = false;
    if ((inFlight?.run.trackRunId === runId || !hasAvailableTracks) && worker) {
      interrupted = worker;
      worker.interrupt();
    }
    kick();
  }
  return {
    start(run: z.infer<typeof audioRunSchema>) {
      if (
        closed ||
        tracks.size >= speechLimits.maxTracks ||
        tracks.has(run.trackRunId)
      )
        throw new Error("Speech track capacity exceeded");
      tracks.set(run.trackRunId, createTrack(run));
      publish(run.trackRunId);
    },
    media(runId: string, generation: string) {
      tracks.get(runId)?.media(generation);
    },
    async accept(
      runId: string,
      block: Parameters<ReturnType<typeof createUtterances>["accept"]>[0],
      samples: Float32Array,
      origin: number,
    ) {
      await tracks.get(runId)?.accept(block, samples, origin);
    },
    end,
    unavailable,
    retry() {
      if (closed) return;
      failures = 0;
      nextLoadAt = 0;
      lastError = undefined;
      if (status === "unavailable") status = "sleeping";
      publishAll();
      kick();
    },
    snapshot() {
      return speechRuntimeSchema.parse({
        status,
        processId: worker?.status.processId,
        processRssBytes: worker?.status.rssBytes ?? null,
        modelSha256: worker?.status.modelSha256 ?? null,
        idleUnloadMs: options.config.idleUnloadMs,
        loads,
        failures,
        completed,
        dropped,
        cancelled,
        handoffRejected,
        queueDepth: queue.length,
        queueBytes: queue.reduce((sum, job) => sum + job.samples.byteLength, 0),
        inFlight: inFlight !== undefined,
        error: lastError,
      });
    },
    close() {
      closing ??= (async () => {
        closed = true;
        clearInterval(timer);
        for (const runId of tracks.keys()) end(runId);
        if (worker) {
          interrupted = worker;
          await worker.close();
        }
        await operation;
        worker = undefined;
        status = "closed";
      })();
      return closing;
    },
  };
}
