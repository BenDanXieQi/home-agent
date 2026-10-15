import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import {
  type AgentEventStream,
  type ConversationId,
  type EntryId,
  type Harness,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";
import {
  type DurableCorrelation,
  DurableRecorder,
  type DurableRecorderOptions,
} from "./durable-recorder.js";
import {
  getLangfuseRuntimeInternal,
  type LangfuseRuntime,
} from "./runtime-core.js";

export type { DurableCorrelation } from "./durable-recorder.js";
export type { LangfuseRuntime } from "./runtime-core.js";
export { createLangfuseRuntimeFromBackend } from "./runtime-core.js";
export type {
  Observation,
  ObservationAttributes,
  ObservationType,
  TraceBackend,
} from "./tracing.js";

export interface PiLangfuseDurableOptions extends Omit<
  DurableRecorderOptions,
  "conversationId" | "requestId"
> {
  harness: Harness;
  conversationId: ConversationId;
  context: Context;
  beforeRun?: (inputs: readonly SubmissionId[]) => Promise<void>;
}

export interface PiLangfuseDurableConversation {
  readonly active: boolean;
  readonly closed: Promise<void>;
  observeSubmission(
    id: SubmissionId,
    correlation?: DurableCorrelation,
  ): Promise<void>;
  dispose(): Promise<void>;
}

const observedConversations = new WeakMap<Harness, Set<ConversationId>>();

export async function createPiLangfuseDurableConversation(
  runtime: LangfuseRuntime,
  options: PiLangfuseDurableOptions,
) {
  options = { ...options };
  const { context, cancel } = withCancel(options.context);
  let stream: AgentEventStream | undefined;
  let recorder: DurableRecorder | undefined;
  let releaseRuntime: (() => void) | undefined;
  let disposed = false;
  let ownsConversation = false;
  let initialization: Promise<void> = Promise.resolve();
  let delivery = Promise.resolve();
  let disposePromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function report(stage: string) {
    if (recorder) recorder.report(stage);
    else {
      try {
        Promise.resolve(options.onError?.(stage)).catch(() => {
          console.error("Pi tracing callback failed.");
        });
      } catch {
        console.error("Pi tracing callback failed.");
      }
    }
  }

  async function readEntry(id: EntryId) {
    const entry = await options.harness.commit((tx) => tx.entry(id), context);
    context.abortSignal?.throwIfAborted();
    return entry;
  }

  async function observeSubmission(
    id: SubmissionId,
    correlation?: DurableCorrelation,
  ) {
    if (disposed) return;
    try {
      const submission = await options.harness.submission(id, context);
      if (disposed || !submission) return;
      const record = await submission.status(context);
      if (disposed) return;
      await recorder?.submission(record, readEntry, correlation, true);
    } catch {
      if (!disposed) report("submission status read");
    }
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = Promise.resolve().then(async () => {
      await initialization;
      try {
        await stream?.stop();
      } catch {
        report("observer stop");
      }
      await Promise.allSettled([delivery]);
      recorder?.dispose();
      if (ownsConversation) {
        observedConversations
          .get(options.harness)
          ?.delete(options.conversationId);
        ownsConversation = false;
      }
      releaseRuntime?.();
      releaseRuntime = undefined;
      resolveClosed();
    });
    cancel();
    return disposePromise;
  }

  const controller: PiLangfuseDurableConversation = {
    get active() {
      return !disposed && !runtime.closed && stream !== undefined;
    },
    closed,
    observeSubmission,
    dispose,
  };

  async function initialize() {
    try {
      const conversations =
        observedConversations.get(options.harness) ?? new Set<ConversationId>();
      if (conversations.has(options.conversationId))
        throw new Error("Conversation already has a tracing observer.");
      conversations.add(options.conversationId);
      observedConversations.set(options.harness, conversations);
      ownsConversation = true;
      const internal = getLangfuseRuntimeInternal(runtime);
      releaseRuntime = internal.registerSession(dispose);
      const attached = await watchEvents(
        options.harness,
        options.conversationId,
        context,
      );
      stream = attached;
      if (disposed || runtime.closed) {
        dispose().catch(() => {
          report("observer disposal");
        });
        return;
      }
      if (stream.snapshot.run)
        await options.beforeRun?.(stream.snapshot.run.inputs);
      if (disposed || runtime.closed) {
        dispose().catch(() => {
          report("observer disposal");
        });
        return;
      }
      recorder = new DurableRecorder(internal.backend, {
        ...options,
        metadata: { ...options.metadata },
      });
      if (disposed || runtime.closed) {
        recorder.dispose();
        dispose().catch(() => {
          report("observer disposal");
        });
        return;
      }
      recorder.snapshot(stream.snapshot, true);
      stream.start((events) => {
        delivery = (async () => {
          for (const event of events) {
            if (disposed) return;
            try {
              if (event.type === "snapshot") {
                if (event.run) await options.beforeRun?.(event.run.inputs);
                if (disposed) return;
                recorder?.snapshot(event);
                const ids = new Set([
                  ...(recorder?.submissionIds ?? []),
                  ...(event.run?.inputs ?? []),
                  ...event.inbox.map((item) => item.id),
                ]);
                for (const id of ids) {
                  await observeSubmission(id);
                  if (disposed) return;
                }
              } else if (event.type === "submission") {
                await recorder?.submission(event.record, readEntry);
                if (disposed) return;
              } else {
                if (event.type === "run_start")
                  await options.beforeRun?.(event.inputs);
                if (disposed) return;
                recorder?.event(event);
              }
            } catch {
              if (!disposed) report("observer delivery");
            }
          }
        })();
        return delivery;
      });
      stream.closed
        .then(
          (end) => {
            if (
              end.reason === "listener_error" ||
              end.reason === "session_failed"
            )
              report("observer closure");
            return dispose();
          },
          () => {
            report("observer closure");
            return dispose();
          },
        )
        .catch(() => {
          report("observer closure");
        });
      const ids = new Set([
        ...(stream.snapshot.run?.inputs ?? []),
        ...stream.snapshot.inbox.map((item) => item.id),
      ]);
      for (const id of ids) {
        await observeSubmission(id);
        if (disposed) return;
      }
    } catch {
      report("observer initialization");
      dispose().catch(() => {
        report("observer disposal");
      });
    }
  }
  initialization = initialize();
  await initialization;
  if (disposed) await dispose();
  return controller;
}
