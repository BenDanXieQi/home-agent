import pTimeout from "p-timeout";
import { AppError, errorPayload } from "@home-agent/api/errors";
import {
  speechDialogueLimits,
  speechDialogueConfigSchema,
  type speechInboxEntrySchema,
  speechInboxSchema,
  type speechDialogueResponseSchema,
  validSpeechDialogueRequest,
  type speechDialogueRequestSchema,
} from "@home-agent/api/speech-dialogue";
import type {
  audioRunSchema,
  speechObservationSchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";

// Owns short-lived speech handoff and interpretation. Never executes an action.
export function createSpeechInbox(options: {
  instanceId: string;
  analyze?: (
    request: z.infer<typeof speechDialogueRequestSchema>,
    signal: AbortSignal,
  ) => Promise<z.infer<typeof speechDialogueResponseSchema>>;
}) {
  const instanceId = speechInboxSchema.shape.instanceId.parse(
    options.instanceId,
  );
  let revision = 0;
  const listeners = new Set<() => void>();
  function notify() {
    revision++;
    for (const listener of listeners) listener();
  }
  const runs = new Map<
    string,
    { run: z.infer<typeof audioRunSchema>; lastEndSample: number }
  >();
  const entries = new Map<string, z.infer<typeof speechInboxEntrySchema>>();
  let config = speechDialogueConfigSchema.parse({});
  let sequence = 0,
    rejected = 0;
  let closed = false;
  let operation: Promise<void> | undefined;
  let active:
    | {
        entry: z.infer<typeof speechInboxEntrySchema>;
        controller: AbortController;
      }
    | undefined;
  const calls: number[] = [];
  function expire() {
    const now = Date.now();
    let removed = false;
    for (const [id, entry] of entries) {
      if (now >= entry.expiresAt) {
        if (active?.entry === entry)
          active?.controller.abort(new Error("Speech evidence expired"));
        entries.delete(id);
        removed = true;
      }
    }
    if (removed) notify();
  }
  async function drain() {
    if (closed) return;
    if (!config.enabled) return;
    while (calls.length && performance.now() - calls[0]! >= 60000)
      calls.shift();
    if (calls.length >= config.callsPerMinute) return;
    const entry = [...entries.values()].find(
      (item) => item.status === "pending",
    );
    if (!entry) return;
    if (!options.analyze) {
      entry.status = "unavailable";
      entry.error = errorPayload(new AppError("agent_unavailable"));
      notify();
      return;
    }
    const observation = entry.observation;
    const request = {
      id: crypto.randomUUID(),
      expiresAt: entry.expiresAt,
      assistantNames: config.assistantNames,
      current: observation,
      preceding: [...entries.values()]
        .filter(
          (item) =>
            item.sequence < entry.sequence &&
            item.observation.run.trackRunId === observation.run.trackRunId &&
            item.observation.generation === observation.generation,
        )
        .slice(-speechDialogueLimits.contextSegments)
        .map((item) => item.observation),
    };
    if (!validSpeechDialogueRequest(request, Date.now())) {
      entry.status = "unavailable";
      entry.error = errorPayload(new AppError("invalid_request"));
      notify();
      return;
    }
    const controller = new AbortController();
    active = { entry, controller };
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(
        Math.max(
          1,
          Math.min(
            speechDialogueLimits.timeoutMs,
            Math.floor(entry.expiresAt - Date.now()),
          ),
        ),
      ),
    ]);
    entry.status = "analyzing";
    calls.push(performance.now());
    try {
      notify();
      const response = await pTimeout(
        options.analyze(structuredClone(request), signal),
        {
          milliseconds: speechDialogueLimits.timeoutMs,
          signal,
        },
      );
      signal.throwIfAborted();
      expire();
      if (entries.get(observation.id) !== entry) return;
      if (
        response.id !== request.id ||
        response.observationId !== observation.id
      )
        throw new AppError("agent_execution_failed");
      entry.decision = structuredClone(response.decision);
      entry.status = response.decision.needsResponse
        ? response.decision.isComplete
          ? "ready"
          : "incomplete"
        : "ignored";
    } catch (cause) {
      expire();
      if (entries.get(observation.id) === entry) {
        entry.status = "unavailable";
        const error = signal.aborted
          ? new AppError(
              signal.reason instanceof Error &&
                signal.reason.name === "TimeoutError"
                ? "run_timeout"
                : "request_cancelled",
            )
          : cause instanceof AppError
            ? cause
            : new AppError("agent_execution_failed");
        const { traceId, ...params } = error.details.params ?? {};
        entry.error = {
          ...errorPayload(
            error,
            typeof traceId === "string" ? traceId : undefined,
          ),
          params: Object.keys(params).length ? params : undefined,
        };
      }
    } finally {
      active = undefined;
      notify();
    }
  }
  function kick() {
    if (closed || operation) return;
    operation = drain()
      .catch(() => {
        console.error("Speech inbox operation failed");
      })
      .finally(() => {
        operation = undefined;
      });
  }
  const timer = setInterval(() => {
    expire();
    kick();
  }, 250);
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    configure(value: z.infer<typeof speechDialogueConfigSchema>) {
      if (closed) return;
      config = structuredClone(value);
      notify();
    },
    authorize(run: z.infer<typeof audioRunSchema>) {
      if (closed) return;
      runs.set(run.trackRunId, { run: structuredClone(run), lastEndSample: 0 });
    },
    revoke(runId: string) {
      if (!runs.has(runId)) return;
      runs.delete(runId);
      if (active?.entry.observation.run.trackRunId === runId)
        active.controller.abort(new Error("Speech source revoked"));
      for (const [id, entry] of entries)
        if (entry.observation.run.trackRunId === runId) entries.delete(id);
      notify();
    },
    accept(observation: z.infer<typeof speechObservationSchema>) {
      expire();
      const source = runs.get(observation.run.trackRunId);
      if (
        closed ||
        !source ||
        source.run.scopeEpoch !== observation.run.scopeEpoch ||
        source.run.deviceId !== observation.run.deviceId ||
        observation.endSample <= source.lastEndSample ||
        Date.now() - observation.observedEndAt >=
          speechDialogueLimits.lifetimeMs ||
        observation.observedEndAt > Date.now() + 2000
      ) {
        rejected++;
        notify();
        return false;
      }
      source.lastEndSample = observation.endSample;
      if (entries.size >= speechDialogueLimits.entries) {
        rejected++;
        notify();
        return false;
      }
      const entry = structuredClone({
        sequence: ++sequence,
        observation,
        expiresAt: observation.observedEndAt + speechDialogueLimits.lifetimeMs,
        status: !observation.text.trim()
          ? "ignored"
          : config.enabled
            ? "pending"
            : "captured",
        decision: null,
        error: null,
      } satisfies z.infer<typeof speechInboxEntrySchema>);
      entries.set(observation.id, entry);
      notify();
      kick();
      return true;
    },
    snapshot() {
      expire();
      return structuredClone({
        instanceId,
        settings: config,
        revision,
        sequence,
        rejected,
        entries: [...entries.values()],
      } satisfies z.infer<typeof speechInboxSchema>);
    },
    async close() {
      closed = true;
      clearInterval(timer);
      active?.controller.abort(new Error("Speech inbox closed"));
      runs.clear();
      entries.clear();
      await operation;
      listeners.clear();
    },
  };
}
