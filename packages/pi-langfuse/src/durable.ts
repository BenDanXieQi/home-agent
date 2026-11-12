import type { Context } from "@earendil-works/chord/context";
import { withCancel } from "@earendil-works/chord/context";
import {
  LiveDoc,
  InboxDoc,
  NestedCallDoc,
  type LiveState,
  type InboxState,
  type NestedCallState,
  type ConversationId,
  type EntryId,
  type Harness,
  type SubmissionId,
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

export type PiLangfuseDurableConversation = Awaited<
  ReturnType<typeof createPiLangfuseDurableConversation>
>;

const observedConversations = new WeakMap<Harness, Set<ConversationId>>();

export async function createPiLangfuseDurableConversation(
  runtime: LangfuseRuntime,
  options: PiLangfuseDurableOptions,
) {
  options = { ...options };
  const { context, cancel } = withCancel(options.context);
  let viewObservation:
    | Awaited<ReturnType<Harness["observeConversation"]>>
    | undefined;
  const ready = Promise.withResolvers<void>();
  let recorder: DurableRecorder | undefined;
  let releaseRuntime: (() => void) | undefined;
  let releaseCommits: (() => void) | undefined;
  let disposed = false;
  let ownsConversation = false;
  let initialization: Promise<void> = Promise.resolve();
  let delivery = Promise.resolve();
  let disposePromise: Promise<void> | undefined;
  let incomplete = false;
  const submissionObservations = new Map<
    SubmissionId,
    ReturnType<typeof Promise.withResolvers<boolean>>
  >();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function interruptObservations() {
    incomplete = true;
    for (const observation of submissionObservations.values())
      observation.resolve(false);
  }

  function submissionObservation(id: SubmissionId) {
    let observation = submissionObservations.get(id);
    if (!observation) {
      observation = Promise.withResolvers<boolean>();
      submissionObservations.set(id, observation);
    }
    return observation;
  }

  function report(stage: string) {
    interruptObservations();
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
    disposePromise = Promise.resolve().then(async () => {
      await initialization;
      releaseCommits?.();
      releaseCommits = undefined;
      viewObservation?.detach();
      await Promise.allSettled([delivery]);
      disposed = true;
      cancel();
      recorder?.dispose();
      interruptObservations();
      submissionObservations.clear();
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
    return disposePromise;
  }

  const controller = {
    get active() {
      return (
        !disposePromise &&
        !disposed &&
        !runtime.closed &&
        viewObservation !== undefined
      );
    },
    closed,
    observeSubmission,
    whenSubmissionObserved(id: SubmissionId) {
      if (!controller.active || incomplete) return Promise.resolve(false);
      return submissionObservation(id).promise;
    },
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
      let preparedInputs: readonly SubmissionId[] = [];
      async function beforeRun(live: LiveState) {
        const inputs = live.run?.inputs ?? [];
        if (
          inputs.length === preparedInputs.length &&
          inputs.every((id, index) => id === preparedInputs[index])
        )
          return;

        preparedInputs = inputs;
        if (inputs.length) await options.beforeRun?.(inputs);
      }

      function enqueue(action: () => Promise<void>) {
        delivery = delivery.then(async () => {
          await ready.promise;
          if (disposed) return;
          try {
            await action();
          } catch {
            report("observer delivery");
          }
        });
      }
      function ended() {
        dispose().catch(() => {
          report("observer disposal");
        });
      }
      const commits = options.harness.observeCommits({
        advance(publication) {
          const terminal: SubmissionId[] = [];
          for (const change of publication.changes) {
            if (
              change.type === "submission" &&
              change.value.conversationId === options.conversationId
            ) {
              submissionObservation(change.value.id);
              enqueue(async () => {
                await recorder?.submission(change.value, readEntry);
              });
              if (
                change.value.status === "done" ||
                change.value.status === "unanswered"
              )
                terminal.push(change.value.id);
            } else if (
              change.type === "document" &&
              change.kind === "change" &&
              change.conversationId === options.conversationId &&
              change.record.kind === NestedCallDoc.definition.kind
            ) {
              const state = change.value as NestedCallState;
              enqueue(async () => {
                recorder?.nestedResult(state);
              });
            }
          }
          // A run can settle several inputs in one publication; finish all records first.
          if (terminal.length)
            enqueue(async () => {
              for (const id of terminal)
                submissionObservation(id).resolve(!incomplete);
            });
        },
        end: ended,
      });
      releaseCommits = () => commits.detach();
      viewObservation = await options.harness.observeConversation(
        options.conversationId,
        {
          advance(change) {
            if (change.kind === "failed") {
              report("conversation observation");
              return;
            }
            const live = (change.value.docs[LiveDoc.definition.kind] ??
              {}) as LiveState;
            enqueue(async () => {
              await beforeRun(live);
              await recorder?.view(change.value, live, readEntry);
            });
          },
          end: ended,
        },
        context,
      );
      const initial = viewObservation.value;
      const live = (initial.docs[LiveDoc.definition.kind] ?? {}) as LiveState;
      const inbox = (initial.docs[InboxDoc.definition.kind] ??
        {}) as Partial<InboxState>;
      const initialSubmissionIds = new Set([
        ...(live.run?.inputs ?? []),
        ...(inbox.items ?? []).map((item) => item.id),
      ]);
      for (const id of initialSubmissionIds)
        submissionObservation(id).resolve(false);
      if (disposed || runtime.closed) {
        dispose().catch(() => {
          report("observer disposal");
        });
        return;
      }
      await beforeRun(live);
      if (disposed || runtime.closed) {
        dispose().catch(() => {
          report("observer disposal");
        });
        return;
      }
      recorder = new DurableRecorder(internal.backend, {
        ...options,
        metadata: { ...options.metadata },
        onError: (stage) => {
          interruptObservations();
          return options.onError?.(stage);
        },
      });
      if (disposed || runtime.closed) {
        recorder.dispose();
        dispose().catch(() => {
          report("observer disposal");
        });
        return;
      }
      recorder.snapshot(initial, live, true);
      for (const id of initialSubmissionIds) {
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
  initialization = initialize().finally(() => ready.resolve());
  await initialization;
  if (disposePromise) await disposePromise;
  return controller;
}
