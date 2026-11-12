import type {
  ConversationView,
  LiveState,
  ToolSlot,
  NestedToolSlot,
  NestedCallState,
  TaskId,
  ConversationId,
  EntryId,
  EntryRecord,
  SubmissionId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import {
  durableAttributes,
  durableContent,
  durableToolDiagnostics,
  durableUsage,
} from "./durable-projection.js";
import { sanitizeTraceValue } from "./sanitizer.js";
import type {
  Observation,
  ObservationAttributes,
  ObservationSource,
  TraceBackend,
} from "./tracing.js";

export interface DurableCorrelation {
  requestId?: string;
  userId?: string;
  applicationId?: string;
}

export interface DurableRecorderOptions extends DurableCorrelation {
  conversationId: ConversationId;
  sessionId?: string;
  traceName?: string;
  captureContent?: boolean;
  generations?: "observer" | "provider";
  metadata?: Readonly<Record<string, unknown>>;
  submissionCorrelation?: (record: SubmissionRecord) => DurableCorrelation;
  onTraceId?: (traceId: string) => void | Promise<void>;
  onError?: (stage: string) => void | Promise<void>;
}

const SAFE_UNANSWERED_REASONS = new Set([
  "aborted",
  "model_error",
  "no_model",
  "reset",
  "stale",
  "faulted",
  "orphaned",
  "interrupted",
  "restart_limit",
  "nothing_to_answer",
  "turn_limit",
]);

function submissionOutcome(record: SubmissionRecord) {
  if (record.status !== "done" && record.status !== "unanswered")
    return undefined;
  const reason =
    record.status === "unanswered" && SAFE_UNANSWERED_REASONS.has(record.reason)
      ? record.reason
      : undefined;
  return {
    level:
      record.status === "done"
        ? ("DEFAULT" as const)
        : reason === "model_error" ||
            reason === "no_model" ||
            reason === "faulted"
          ? ("ERROR" as const)
          : ("WARNING" as const),
    metadata: {
      "pi.durable.submission_status": record.status,
      "pi.durable.answer_entry_id": record.answer,
      ...(record.status === "unanswered"
        ? { "pi.durable.unanswered_reason": reason ?? "unknown" }
        : {}),
    },
  };
}

interface Span {
  observation?: Observation | undefined;
  ended: boolean;
}
interface SubmissionSpan {
  span: Span;
  correlation: DurableCorrelation;
  terminal: boolean;
  content: Pick<ObservationAttributes, "input" | "output">;
  outcome?: ReturnType<typeof submissionOutcome>;
}
interface RunSpan {
  span: Span;
  primary: SubmissionId;
  inputs: readonly SubmissionId[];
  correlation: DurableCorrelation;
  round: number;
  generationActive: boolean;
  generation?: Span | undefined;
  tools: Map<string, Span>;
  toolArguments: Map<string, unknown>;
  completedTools: Set<string>;
}

export class DurableRecorder {
  private readonly backend;
  private readonly options;
  private readonly root: Span;
  private run: RunSpan | undefined;
  private readonly submissions = new Map<SubmissionId, SubmissionSpan>();
  private readonly pendingSubmissions = new Set<SubmissionId>();
  private readonly entries = new Set<number>();
  private readonly completedRuns = new Set<SubmissionId>();
  private readonly settlingRuns = new Map<
    SubmissionId,
    { run: RunSpan; endTime: number }
  >();
  private disposed = false;
  private gaps = 0;
  private readonly nestedResults = new Map<TaskId, NestedCallState>();
  private readonly nestedTools = new Map<TaskId, NestedToolSlot>();

  constructor(backend: TraceBackend, options: DurableRecorderOptions) {
    this.backend = backend;
    this.options = options;
    this.root = this.start({ kind: "conversation" }, undefined, {
      metadata: {
        ...this.customMetadata(),
        "pi.runtime": "durable",
        "pi.durable.schema_version": "1",
        "pi.durable.conversation_id": options.conversationId,
        ...(options.applicationId
          ? { "pi.application.id": options.applicationId }
          : {}),
      },
    });
    this.safe(() => {
      this.root.observation?.updateTrace?.(
        durableAttributes({
          name: options.traceName ?? "pi.durable.conversation",
          sessionId: options.sessionId ?? String(options.conversationId),
          ...(options.userId ? { userId: options.userId } : {}),
          metadata: this.customMetadata(),
          version: "durable-1",
        }),
      );
    });
    const traceId = this.root.observation?.traceId;
    if (traceId)
      this.callback("trace-id callback", () => options.onTraceId?.(traceId));
  }

  get submissionIds() {
    return [...this.pendingSubmissions];
  }

  report(stage: string) {
    this.callback("error callback", () => this.options.onError?.(stage), false);
  }

  private callback(
    stage: string,
    action: () => void | Promise<void>,
    report = true,
  ) {
    try {
      Promise.resolve(action()).catch(() => {
        if (report) this.report(stage);
        else console.error("Pi tracing error callback failed.");
      });
    } catch {
      if (report) this.report(stage);
      else console.error("Pi tracing error callback failed.");
    }
  }

  private customMetadata() {
    const value = sanitizeTraceValue(this.options.metadata, true);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const entries: [string, unknown][] = Object.entries(value);
    return Object.fromEntries(
      entries.filter(([key]) => !key.startsWith("pi.")),
    );
  }

  private safe(action: () => void) {
    try {
      action();
    } catch {
      this.report("exporter observation");
    }
  }

  private start(
    source: ObservationSource,
    parent?: Span,
    attributes: ObservationAttributes = {},
  ) {
    if (this.disposed || (parent && (parent.ended || !parent.observation)))
      return { ended: true };
    const span: Span = { ended: false };
    const inherited = this.correlationAttributes(
      parent && parent !== this.root ? (this.run?.correlation ?? {}) : {},
    );
    this.safe(() => {
      span.observation = this.backend.start(
        this.options.conversationId,
        source,
        durableAttributes({
          version: "durable-1",
          sessionId:
            this.options.sessionId ?? String(this.options.conversationId),
          ...(this.options.userId ? { userId: this.options.userId } : {}),
          ...inherited,
          ...attributes,
          metadata: { ...inherited.metadata, ...attributes.metadata },
        }),
      );
    });
    if (!span.observation) span.ended = true;
    if (this.disposed)
      this.interrupted(span, "Observer disposed during exporter start.");
    return span;
  }

  private update(span: Span, attributes: ObservationAttributes) {
    if (!span.ended)
      this.safe(() => {
        span.observation?.update(durableAttributes(attributes));
      });
  }

  private end(
    span: Span | undefined,
    attributes: ObservationAttributes = {},
    endTime?: number,
  ) {
    if (!span || span.ended) return;
    span.ended = true;
    const observation = span.observation;
    span.observation = undefined;
    this.safe(() => {
      observation?.update(durableAttributes(attributes));
    });
    this.safe(() => {
      observation?.end(endTime);
    });
  }

  private interrupted(span: Span | undefined, reason: string) {
    this.end(span, {
      level: "WARNING",
      statusMessage: reason,
      metadata: { "pi.durable.outcome": "observation_interrupted" },
    });
  }

  private correlationAttributes(correlation: DurableCorrelation) {
    return {
      metadata: {
        ...(correlation.userId ? { "pi.user.id": correlation.userId } : {}),
        ...(correlation.requestId
          ? { "pi.request.id": correlation.requestId }
          : {}),
        ...(correlation.applicationId
          ? { "pi.application.id": correlation.applicationId }
          : {}),
      },
    };
  }

  private correlationValues(correlation: DurableCorrelation) {
    const sanitized = sanitizeTraceValue(correlation, true);
    if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized))
      return {};
    const entries: [string, unknown][] = Object.entries(sanitized);
    return Object.fromEntries(
      entries
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [key, String(value)] as const),
    );
  }

  async submission(
    record: SubmissionRecord,
    readEntry: (id: EntryId) => Promise<EntryRecord | undefined>,
    correlation?: DurableCorrelation,
    snapshot = false,
  ) {
    if (this.disposed || record.conversationId !== this.options.conversationId)
      return;
    let state = this.submissions.get(record.id);
    if (!state) {
      let host: DurableCorrelation = {};
      try {
        host = this.options.submissionCorrelation?.(record) ?? {};
      } catch {
        this.report("submission correlation");
      }
      if (this.disposed) return;
      const ids = this.correlationValues({
        ...(record.requestId !== undefined
          ? { requestId: record.requestId }
          : {}),
        ...(this.options.userId !== undefined
          ? { userId: this.options.userId }
          : {}),
        ...(this.options.applicationId !== undefined
          ? { applicationId: this.options.applicationId }
          : {}),
        ...host,
        ...correlation,
      });
      state = {
        span: this.start(
          { kind: "submission", id: record.id, requestId: ids.requestId },
          this.root,
          {
            ...this.correlationAttributes(ids),
            metadata: {
              ...this.correlationAttributes(ids).metadata,
              "pi.durable.submission_id": record.id,
              "pi.durable.submission_type": record.type,
              "pi.durable.snapshot_observation": snapshot,
            },
          },
        ),
        correlation: ids,
        terminal: false,
        content: {},
      };
      if (this.disposed) return;
      this.submissions.set(record.id, state);
      this.pendingSubmissions.add(record.id);
    }
    if (state.terminal) return;
    if (
      !snapshot &&
      record.status === "placed" &&
      this.run &&
      !this.run.inputs.includes(record.id)
    ) {
      this.run.inputs = [...this.run.inputs, record.id];
      this.update(this.run.span, {
        metadata: { "pi.durable.inputs": this.run.inputs },
      });
    }
    if (correlation) {
      state.correlation = this.correlationValues({
        ...state.correlation,
        ...correlation,
      });
      this.update(state.span, this.correlationAttributes(state.correlation));
    }
    const run =
      this.run?.primary === record.id
        ? this.run
        : this.settlingRuns.get(record.id)?.run;
    if (run?.primary === record.id) {
      run.correlation = state.correlation;
      const attributes = this.correlationAttributes(state.correlation);
      this.update(run.span, attributes);
      if (run.generation) this.update(run.generation, attributes);
      for (const tool of run.tools.values()) this.update(tool, attributes);
    }
    this.update(state.span, {
      metadata: { "pi.durable.submission_status": record.status },
    });
    const outcome = submissionOutcome(record);
    if (record.entry !== undefined && record.type === "input") {
      const entry = await readEntry(record.entry);
      if (this.disposed || state.terminal) return;
      state.content.input = durableContent(
        entry?.model,
        this.options.captureContent ?? true,
      );
      this.update(state.span, { input: state.content.input });
    }
    if (record.status === "done" || record.status === "unanswered") {
      if (record.status === "done" && record.type === "input") {
        const entry = await readEntry(record.answer);
        if (this.disposed || state.terminal) return;
        state.content.output = durableContent(
          entry?.model,
          this.options.captureContent ?? true,
        );
      }
      state.terminal = true;
      state.outcome = outcome;
      this.pendingSubmissions.delete(record.id);
      this.end(state.span, {
        ...state.content,
        ...outcome,
      });
      for (const [primary, settling] of this.settlingRuns)
        if (settling.run.inputs.includes(record.id)) this.settleRun(primary);
    }
  }

  snapshot(snapshot: ConversationView, live: LiveState, initial = false) {
    if (this.disposed) return;
    for (const entry of snapshot.entries) this.entries.add(entry.id);
    if (!initial) {
      this.gaps += 1;
      this.update(this.root, {
        metadata: {
          "pi.durable.resync_count": this.gaps,
          "pi.durable.history_complete": false,
        },
      });
    } else
      this.update(this.root, {
        metadata: {
          "pi.durable.history_complete": false,
          "pi.durable.attachment": "snapshot",
        },
      });
    const primary = live.run?.inputs[0];
    if (this.run && this.run.primary !== primary)
      this.closeRun(
        "Run boundary not observed; snapshot replaced the observation.",
      );
    if (this.run)
      this.closeRound(
        "Snapshot replaced generation/tool observation; activity may have been missed.",
      );
    if (live.run) {
      this.beginRun(live.run.inputs, true);
      if (this.run)
        this.update(this.run.span, {
          metadata: { "pi.durable.observation_incomplete": true },
        });
    }
  }

  private beginRun(inputs: readonly SubmissionId[], snapshot = false) {
    const primary = inputs[0];
    if (
      primary === undefined ||
      this.completedRuns.has(primary) ||
      this.settlingRuns.has(primary)
    )
      return;
    if (this.run?.primary === primary) {
      this.run.inputs = [...inputs];
      this.update(this.run.span, {
        metadata: { "pi.durable.inputs": this.run.inputs },
      });
      return;
    }
    if (this.run) this.closeRun("Unexpected run replacement.");
    const correlation = this.submissions.get(primary)?.correlation ?? {};
    this.run = {
      span: this.start({ kind: "run", primary }, this.root, {
        ...this.correlationAttributes(correlation),
        metadata: {
          ...this.correlationAttributes(correlation).metadata,
          "pi.durable.primary_submission_id": primary,
          "pi.durable.inputs": [...inputs],
          "pi.durable.snapshot_observation": snapshot,
        },
      }),
      primary,
      inputs: [...inputs],
      correlation,
      round: 0,
      generationActive: false,
      tools: new Map(),
      toolArguments: new Map(),
      completedTools: new Set(),
    };
  }

  private closeRound(reason: string, run = this.run) {
    if (!run) return;
    this.interrupted(run.generation, reason);
    run.generation = undefined;
    run.generationActive = false;
    for (const tool of run.tools.values()) this.interrupted(tool, reason);
    run.tools.clear();
    run.toolArguments.clear();
    this.nestedResults.clear();
    this.nestedTools.clear();
  }

  private closeRun(reason?: string) {
    const run = this.run;
    if (!run) return;
    const settling = { run, endTime: Date.now() };
    this.run = undefined;
    this.settlingRuns.set(run.primary, settling);
    this.closeRound(
      reason ?? "Run ended without an observed descendant completion.",
      run,
    );
    if (reason) {
      this.settlingRuns.delete(run.primary);
      this.completedRuns.add(run.primary);
      this.end(
        run.span,
        {
          level: "WARNING",
          statusMessage: reason,
          metadata: { "pi.durable.observation_incomplete": true },
        },
        settling.endTime,
      );
    } else this.settleRun(run.primary);
  }

  private settleRun(primary: SubmissionId) {
    const settling = this.settlingRuns.get(primary);
    const submission = this.submissions.get(primary);
    if (!settling || !submission?.terminal || !submission.outcome) return;
    const submissions = settling.run.inputs.map((id) =>
      this.submissions.get(id),
    );
    if (submissions.some((state) => !state?.terminal)) return;

    this.settlingRuns.delete(primary);
    this.completedRuns.add(primary);
    const input =
      this.options.captureContent === false
        ? "[content capture disabled]"
        : submissions.flatMap((state) =>
            Array.isArray(state?.content.input) ? state.content.input : [],
          );
    this.end(
      settling.run.span,
      { input, output: submission.content.output, ...submission.outcome },
      settling.endTime,
    );
    for (const state of submissions) if (state) state.content = {};
  }

  private generation() {
    const run = this.run;
    if (!run) return undefined;
    if (!run.generationActive) {
      run.round += 1;
      run.generationActive = true;
      if (this.options.generations !== "provider")
        run.generation = this.start(
          { kind: "generation", primary: run.primary },
          run.span,
          {
            metadata: { "pi.durable.observed_generation_index": run.round },
          },
        );
    }
    return run.generation;
  }

  async view(
    view: ConversationView,
    live: LiveState,
    readEntry: (id: EntryId) => Promise<EntryRecord | undefined>,
  ) {
    if (this.disposed) return;
    if (!this.run && live.run) this.beginRun(live.run.inputs);

    for (const entry of view.entries) {
      if (this.entries.has(entry.id)) continue;
      const message = entry.model?.[0];
      if (message?.role !== "assistant") continue;
      this.entries.add(entry.id);
      if (this.run && this.options.captureContent !== false)
        for (const block of message.content)
          if (block.type === "toolCall")
            this.run.toolArguments.set(
              block.id,
              sanitizeTraceValue(block.arguments, true),
            );

      const generation = this.generation();
      if (this.run) {
        this.run.generation = undefined;
        this.run.generationActive = false;
      }
      this.end(generation, {
        output: durableContent(
          entry.model,
          this.options.captureContent ?? true,
        ),
        model: message.responseModel ?? message.model,
        ...durableUsage(message.usage),
        level:
          message.stopReason === "error"
            ? "ERROR"
            : message.stopReason === "aborted"
              ? "WARNING"
              : "DEFAULT",
        metadata: {
          "pi.durable.entry_id": entry.id,
          "pi.durable.task_id": entry.byTaskId,
          "pi.durable.stop_reason": message.stopReason,
          "pi.durable.provider": message.provider,
          "pi.durable.response_id": message.responseId,
        },
      });
    }

    for (const slot of [...(live.tools ?? []), ...(live.nestedTools ?? [])]) {
      if (!this.run || slot.status === "pending") continue;
      this.toolStarted(slot);
      if ("parentCallId" in slot) {
        this.nestedTools.set(slot.taskId, slot);
        const state = this.nestedResults.get(slot.taskId);
        if (state) this.nestedResult(state);
        else if (slot.status === "done" && !slot.summary) {
          this.toolFinished(slot);
          this.nestedTools.delete(slot.taskId);
        }
      } else if (slot.status === "done") {
        this.toolFinished(
          slot,
          slot.entry === undefined ? undefined : await readEntry(slot.entry),
        );
      }
    }

    if (this.run && live.runFailure?.inputs.includes(this.run.primary))
      this.update(this.run.span, {
        metadata: { "pi.durable.failed_task_id": live.runFailure.taskId },
      });

    if (this.run && this.run.primary !== live.run?.inputs[0]) this.closeRun();
    if (live.run) this.beginRun(live.run.inputs);
    if (live.generation?.retry) {
      this.end(this.run?.generation, {
        level: "ERROR",
        statusMessage: "Provider attempt will retry.",
        metadata: { "pi.durable.retry_attempt": live.generation.attempt },
      });
      if (this.run) {
        this.run.generation = undefined;
        this.run.generationActive = false;
      }
    } else if (live.generation) this.generation();
  }

  private toolStarted(slot: ToolSlot | NestedToolSlot) {
    const run = this.run;
    if (
      !run ||
      run.tools.has(slot.callId) ||
      run.completedTools.has(`${run.round}:${slot.callId}`)
    )
      return;
    const parent =
      "parentCallId" in slot ? run.tools.get(slot.parentCallId) : undefined;
    const args =
      "arguments" in slot ? slot.arguments : run.toolArguments.get(slot.callId);
    run.tools.set(
      slot.callId,
      this.start(
        { kind: "tool", primary: run.primary, call: slot },
        parent ?? run.span,
        {
          input:
            this.options.captureContent === false
              ? "[content capture disabled]"
              : sanitizeTraceValue(args, true),
          metadata: {
            "pi.durable.tool_call_id": slot.callId,
            "pi.durable.tool_name": sanitizeTraceValue(slot.name),
            "pi.durable.task_id": slot.taskId,
            ...("parentCallId" in slot
              ? {
                  "pi.durable.parent_tool_call_id": slot.parentCallId,
                  "pi.durable.parent_task_id": slot.parentTaskId,
                }
              : {}),
            "pi.durable.observed_generation_index": run.round,
          },
        },
      ),
    );
  }

  nestedResult(state: NestedCallState) {
    if (state.taskId === undefined || state.result === undefined) return;
    const slot = this.nestedTools.get(state.taskId);
    if (!slot) {
      this.nestedResults.set(state.taskId, state);
      return;
    }
    this.toolFinished(slot, undefined, state.result);
    this.nestedResults.delete(state.taskId);
    this.nestedTools.delete(state.taskId);
  }

  private toolFinished(
    slot: ToolSlot | NestedToolSlot,
    entry?: EntryRecord,
    result?: NestedCallState["result"],
  ) {
    const run = this.run;
    if (!run) return;
    const key = `${run.round}:${slot.callId}`;
    if (run.completedTools.has(key)) return;
    this.toolStarted(slot);
    run.completedTools.add(key);
    if (entry) this.entries.add(entry.id);
    const message = entry?.model?.[0];
    const toolMessage = message?.role === "toolResult" ? message : undefined;
    const hasResult = entry !== undefined || result !== undefined;
    const isError = result?.isError ?? toolMessage?.isError;
    const details = result?.details ?? toolMessage?.details;
    const diagnostics = result?.diagnostics ?? durableToolDiagnostics(entry);
    const errorMessage =
      diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.message)
        .join("\n") ||
      toolMessage?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n") ||
      (typeof result?.structuredOutput === "string"
        ? result.structuredOutput
        : undefined);
    this.end(run.tools.get(slot.callId), {
      output: result
        ? this.options.captureContent === false
          ? "[content capture disabled]"
          : sanitizeTraceValue(result.structuredOutput, true)
        : durableContent(entry?.model, this.options.captureContent ?? true),
      ...durableUsage(result?.usage ?? toolMessage?.usage),
      level: isError ? "ERROR" : hasResult ? "DEFAULT" : "WARNING",
      ...(isError && this.options.captureContent !== false && errorMessage
        ? { statusMessage: errorMessage }
        : {}),
      metadata: {
        "pi.durable.result_entry_id": entry?.id,
        "pi.durable.result_missing": !hasResult,
        "pi.durable.tool_duration_ms":
          result?.durationMs ?? toolMessage?.durationMs,
        ...(this.options.captureContent !== false && diagnostics.length > 0
          ? {
              "pi.durable.tool_diagnostics": sanitizeTraceValue(
                diagnostics,
                true,
              ),
            }
          : {}),
        ...(this.options.captureContent !== false && details !== undefined
          ? { "pi.durable.tool_details": sanitizeTraceValue(details, true) }
          : {}),
      },
    });
    run.tools.delete(slot.callId);
    run.toolArguments.delete(slot.callId);
  }

  dispose(reason = "Tracing observer disposed; execution outcome is unknown.") {
    if (this.disposed) return;
    this.disposed = true;
    this.closeRun(reason);
    for (const settling of this.settlingRuns.values())
      this.end(
        settling.run.span,
        {
          level: "WARNING",
          statusMessage: reason,
          metadata: { "pi.durable.observation_incomplete": true },
        },
        settling.endTime,
      );
    this.settlingRuns.clear();
    for (const state of this.submissions.values())
      if (!state.terminal) this.interrupted(state.span, reason);
    this.end(this.root, { metadata: { "pi.durable.resync_count": this.gaps } });
    this.submissions.clear();
    this.pendingSubmissions.clear();
    this.entries.clear();
    this.completedRuns.clear();
  }
}
