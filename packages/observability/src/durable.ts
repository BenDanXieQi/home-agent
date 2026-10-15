import { randomUUID } from "node:crypto";
import {
  createLangfuseRuntimeFromBackend,
  createPiLangfuseDurableConversation,
  type ObservationAttributes,
  type ObservationType,
  type TraceBackend,
} from "@home-agent/pi-langfuse";
import {
  LiveDoc,
  CompactionTask,
  ProviderDoc,
  type Harness,
  type ConversationId,
  type ConversationHandle,
  type SubmissionId,
  type HookApi,
  type ToolHookCall,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
  BACKGROUND_CONTEXT,
  type Context as ExecutionContext,
} from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  trace,
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  isSpanContextValid,
  type Span,
  type Attributes,
  type Context,
} from "@opentelemetry/api";
import { telemetryStatus, flushTelemetry } from "./telemetry";
import { beginOperation } from "./lifecycle";
import { recordFailure, withSpan } from "./spans";
import { withGenAiContext } from "./gen-ai";
import { agentTraceContext } from "./agent-trace";
import { withoutRequestSession } from "./session";
import {
  combineEvaluationContexts,
  evaluationContext,
  hasEvaluationContext,
  recordEvaluationOutput,
  recordEvaluationTool,
} from "./evaluation";

export { observeDurableRegistry } from "./durable-compaction";

type CompactionInvocation = Parameters<
  typeof CompactionTask.definition.phases.summarize
>;

class DurableObservation {
  ended = false;
  readonly inputIds = new Set<SubmissionId>();
  private readonly links = new Set<string>();
  private readonly finish: (() => void) | undefined;
  constructor(
    readonly span: Span | undefined,
    readonly kind: ObservationType,
    readonly correlation: Attributes,
    public parent: Context,
    private readonly onEnd?: (observation: DurableObservation) => void,
    readonly call?: { id: string; name: string; arguments: unknown },
    private readonly ownsEvaluation = false,
  ) {
    this.finish = span ? beginOperation() : undefined;
  }

  get traceId() {
    return this.span?.spanContext().traceId;
  }
  executionContext() {
    return this.span ? trace.setSpan(this.parent, this.span) : this.parent;
  }
  link(parent: Context) {
    const target = trace.getSpanContext(parent);
    if (!target || !isSpanContextValid(target)) return;
    const key = `${target.traceId}:${target.spanId}`;
    if (this.links.has(key)) return;
    this.links.add(key);
    this.span?.addLink({ context: target });
  }
  update(attributes: ObservationAttributes) {
    const span = this.span;
    if (this.ended || !span?.isRecording()) return this;
    const metadata = attributes.metadata ?? {};
    span.setAttributes(
      Object.fromEntries(
        Object.entries(metadata)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [
            key,
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
              ? value
              : JSON.stringify(value),
          ]),
      ),
    );
    if (telemetryStatus().includeContent) {
      for (const field of ["input", "output"] as const) {
        const value = attributes[field];
        if (value === undefined) continue;
        span.setAttribute(
          this.kind === "tool"
            ? field === "input"
              ? "gen_ai.tool.call.arguments"
              : "gen_ai.tool.call.result"
            : `langfuse.observation.${field}`,
          JSON.stringify(value),
        );
      }
      if (this.ownsEvaluation && attributes.output !== undefined)
        context.with(this.parent, () =>
          recordEvaluationOutput(attributes.output),
        );
    }
    if (attributes.level !== undefined)
      span.setAttribute("langfuse.observation.level", attributes.level);
    if (attributes.statusMessage !== undefined)
      span.setAttribute(
        "langfuse.observation.status_message",
        attributes.statusMessage,
      );
    if (attributes.level === "ERROR") {
      span.setAttribute(
        "error.type",
        this.kind === "tool" ? "ToolError" : "AgentError",
      );
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: attributes.statusMessage ?? "Operation failed",
      });
    }
    return this;
  }
  updateTrace(attributes: ObservationAttributes) {
    return this.update(attributes);
  }
  end(endTime?: number) {
    if (this.ended) return this;
    this.ended = true;
    this.span?.end(endTime);
    this.finish?.();
    this.onEnd?.(this);
    return this;
  }
}

const owners = new Map<string, ReturnType<typeof createDurableTracing>>();
const modelParents = new WeakMap<
  AbortSignal,
  Pick<DurableObservation, "correlation" | "executionContext">
>();
async function ownerFor(
  api: Pick<HookApi, "snapshot" | "conversationId">,
  execution: ExecutionContext,
) {
  const provider = await api.snapshot(
    ProviderDoc,
    api.conversationId,
    execution,
  );
  return provider ? owners.get(provider.sessionId) : undefined;
}
export async function prepareDurableGeneration(
  api: HookApi,
  execution: ExecutionContext,
) {
  if (!telemetryStatus().enabled) return;
  await (await ownerFor(api, execution))?.prepareGeneration(api, execution);
}
export async function prepareDurableTool(
  call: ToolHookCall,
  api: HookApi,
  execution: ExecutionContext,
) {
  if (!telemetryStatus().enabled) return;
  await (await ownerFor(api, execution))?.prepareTool(call, api, execution);
}
export async function withDurableCompactionTrace<T>(
  task: CompactionInvocation[0],
  api: CompactionInvocation[1],
  execution: CompactionInvocation[2],
  run: () => Promise<T>,
) {
  if (!telemetryStatus().enabled) return run();
  const owner = await ownerFor(api, execution);
  if (!owner) return run();
  const prepared = await owner.prepareCompaction(task, api, execution);
  return context.with(prepared.parent, () =>
    withGenAiContext(prepared.correlation, () =>
      withSpan(
        "conversation.compact",
        {
          "pi.durable.task_id": task.id,
          "pi.durable.compaction_reason": task.input.reason,
          "pi.durable.compaction_background": task.background,
        },
        async (span) => {
          const parent = trace.setSpan(context.active(), span);
          modelParents.set(api.signal, {
            correlation: prepared.correlation,
            executionContext: () => parent,
          });
          try {
            const result = await run();
            if (span.isRecording()) {
              try {
                const current = await api.getTask(task.id, BACKGROUND_CONTEXT);
                if (!current) throw new Error("Compaction task is unavailable");
                span.setAttribute(
                  "pi.durable.task_status",
                  current.state.status,
                );
                const outcome = current.state.outcome;
                if (outcome)
                  span.setAttribute(
                    "pi.durable.compaction_outcome",
                    outcome.status,
                  );
                if (outcome?.status === "failed") {
                  span.setAttributes({
                    "error.type": "CompactionError",
                    "langfuse.observation.level": "ERROR",
                  });
                  span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: "Compaction failed",
                  });
                }
              } catch {
                span.setAttributes({
                  "pi.durable.observation_incomplete": true,
                  "langfuse.observation.level": "WARNING",
                });
                console.error("Pi tracing: compaction outcome read");
              }
            }
            return result;
          } finally {
            modelParents.delete(api.signal);
          }
        },
      ),
    ),
  );
}
export function withDurableModelTrace<T>(
  signal: AbortSignal | undefined,
  transcript: TranscriptContext,
  run: () => T,
) {
  const parent = signal ? modelParents.get(signal) : undefined;
  return context.with(parent?.executionContext() ?? ROOT_CONTEXT, () =>
    withGenAiContext(
      {
        ...parent?.correlation,
        "home_agent.model.input_message_count": transcript.messages.length,
      },
      run,
    ),
  );
}
export async function withDurableToolTrace<T extends ToolExecutionResult>(
  api: ToolExecutionApi,
  run: () => Promise<T>,
) {
  if (!telemetryStatus().enabled) return run();
  const observation = (await ownerFor(api, BACKGROUND_CONTEXT))?.tool(api);
  return context.with(observation?.executionContext() ?? ROOT_CONTEXT, () =>
    withGenAiContext(observation?.correlation ?? {}, async () => {
      try {
        const result = await run();
        if (observation?.call)
          recordEvaluationTool(observation.call.id, {
            name: observation.call.name,
            arguments: observation.call.arguments,
            result: result.isError
              ? "[tool error content omitted]"
              : (result.structuredOutput ?? result.output),
            status: result.isError ? "error" : "done",
          });
        return result;
      } catch (error) {
        if (observation?.span) recordFailure(observation.span, error);
        if (observation?.call)
          recordEvaluationTool(observation.call.id, {
            name: observation.call.name,
            arguments: observation.call.arguments,
            status:
              error instanceof Error && error.name === "AbortError"
                ? "interrupted"
                : "error",
          });
        throw error;
      }
    }),
  );
}

export function createDurableTracing(harness: Harness, agentName: string) {
  const conversations = new Map<
    ConversationId,
    { sessionId: string; identity: string; providerId: string }
  >();
  const origins = new Map<string, Context>();
  const inputParents = new Map<SubmissionId, Context>();
  const runs = new Map<string, DurableObservation>();
  const tools = new Map<string, DurableObservation>();
  function correlation(id: ConversationId) {
    const conversation = conversations.get(id);
    return {
      "gen_ai.agent.name": agentName,
      "session.id": conversation?.sessionId,
      "gen_ai.conversation.id": conversation?.identity ?? String(id),
      "pi.durable.conversation_id": id,
    };
  }
  function ensureRun(id: ConversationId, inputs: readonly SubmissionId[]) {
    const primary = inputs[0];
    if (primary === undefined)
      throw new Error("Durable run has no input submission");
    const key = `${id}:${primary}`;
    const parents = inputs.flatMap((input) => {
      const parent = inputParents.get(input);
      return parent ? [parent] : [];
    });
    let run = runs.get(key);
    if (!run) {
      const parent = parents.length === 1 ? parents[0]! : ROOT_CONTEXT;
      const attributes = {
        ...correlation(id),
        "gen_ai.operation.name": "invoke_agent",
        "pi.durable.primary_submission_id": primary,
        "pi.durable.inputs": JSON.stringify(inputs),
      };
      const span = trace
        .getTracer("home-agent")
        .startSpan(`invoke_agent ${agentName}`, { attributes }, parent);
      let evaluation = combineEvaluationContexts(parents, parent);
      const ownsEvaluation = !hasEvaluationContext(evaluation);
      if (ownsEvaluation)
        evaluation = evaluationContext(
          span,
          { submission_ids: inputs },
          evaluation,
        );
      run = new DurableObservation(
        span,
        "agent",
        attributes,
        evaluation,
        (ended) => {
          runs.delete(key);
          for (const [toolKey, tool] of tools) {
            if (
              tool.correlation["pi.durable.primary_submission_id"] ===
                primary &&
              tool.correlation["pi.durable.conversation_id"] === id
            ) {
              tool.end();
              tools.delete(toolKey);
            }
          }
          for (const input of ended.inputIds) inputParents.delete(input);
        },
        undefined,
        ownsEvaluation,
      );
      runs.set(key, run);
    } else run.parent = combineEvaluationContexts(parents, run.parent);
    for (const input of inputs) run.inputIds.add(input);
    for (const parent of parents) run.link(parent);
    run.update({ metadata: { "pi.durable.inputs": inputs } });
    return run;
  }
  async function prepareRun(
    id: ConversationId,
    inputs: readonly SubmissionId[],
  ) {
    for (const input of inputs) {
      if (inputParents.has(input)) continue;
      const submission = await harness.submission(input, BACKGROUND_CONTEXT);
      const record = await submission?.status(BACKGROUND_CONTEXT);
      if (record?.requestId) {
        const parent = origins.get(record.requestId);
        if (parent) {
          inputParents.set(input, parent);
          origins.delete(record.requestId);
        }
      }
    }
    return ensureRun(id, inputs);
  }
  function ensureTool(
    id: ConversationId,
    taskId: number,
    callId: string,
    toolName: string,
    args: unknown,
    run: DurableObservation,
    parentCall?: ToolHookCall["parent"],
  ) {
    const key = `${id}:${taskId}:${callId}`;
    let observation = tools.get(key);
    if (observation) return observation;
    const parent = parentCall
      ? (tools.get(`${id}:${parentCall.taskId}:${parentCall.callId}`) ?? run)
      : run;
    const attributes = {
      ...run.correlation,
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.type": "function",
      "gen_ai.tool.name": toolName,
      "gen_ai.tool.call.id": callId,
      "pi.durable.task_id": taskId,
    };
    const span = trace
      .getTracer("home-agent")
      .startSpan(
        `execute_tool ${toolName}`,
        { attributes },
        parent.executionContext(),
      );
    observation = new DurableObservation(
      span,
      "tool",
      attributes,
      parent.executionContext(),
      undefined,
      { id: key, name: toolName, arguments: args },
    ).update({ input: args });
    tools.set(key, observation);
    context.with(observation.executionContext(), () =>
      recordEvaluationTool(key, {
        name: toolName,
        arguments: args,
        status: "running",
      }),
    );
    return observation;
  }
  const backend = {
    start(name, attributes, options) {
      const metadata = attributes.metadata ?? {};
      const inherited =
        options.parent instanceof DurableObservation
          ? options.parent
          : undefined;
      const numericId =
        metadata["pi.durable.conversation_id"] ??
        inherited?.correlation["pi.durable.conversation_id"];
      if (typeof numericId !== "number")
        throw new Error("Durable observation has no conversation ID");
      const id = [...conversations.keys()].find(
        (candidate) => candidate === numericId,
      );
      if (id === undefined)
        throw new Error("Durable conversation is not attached");
      if (name === agentName)
        return new DurableObservation(
          undefined,
          "span",
          correlation(id),
          ROOT_CONTEXT,
        );
      if (name === "pi.durable.run") {
        const primary = metadata["pi.durable.primary_submission_id"];
        if (typeof primary !== "number")
          throw new Error("Durable run has no primary submission ID");
        const run = runs.get(`${id}:${primary}`);
        if (!run) throw new Error("Durable run was not prepared");
        return run.update(attributes);
      }
      if (options.asType === "tool" && inherited) {
        const taskId = metadata["pi.durable.task_id"],
          callId = metadata["pi.durable.tool_call_id"],
          toolName = metadata["pi.durable.tool_name"];
        if (
          typeof taskId === "number" &&
          typeof callId === "string" &&
          typeof toolName === "string"
        )
          return ensureTool(
            id,
            taskId,
            callId,
            toolName,
            attributes.input,
            inherited,
          ).update(attributes);
      }
      const requestId = metadata["pi.request.id"];
      const origin =
        typeof requestId === "string" ? origins.get(requestId) : undefined;
      const inputId = metadata["pi.durable.submission_id"];
      const parent =
        origin ?? [...inputParents].find(([input]) => input === inputId)?.[1];
      const nativeParent =
        parent ?? inherited?.executionContext() ?? ROOT_CONTEXT;
      const span = trace.getTracer("home-agent").startSpan(
        name,
        {
          attributes: correlation(id),
          ...(options.startTime ? { startTime: options.startTime } : {}),
        },
        nativeParent,
      );
      return new DurableObservation(
        span,
        options.asType,
        correlation(id),
        nativeParent,
        typeof requestId === "string"
          ? () => {
              origins.delete(requestId);
            }
          : undefined,
      ).update(attributes);
    },
    forceFlush: flushTelemetry,
    shutdown: async () => {},
  } satisfies TraceBackend;
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const observers = new Map<
    ConversationId,
    ReturnType<typeof createPiLangfuseDurableConversation>
  >();
  const owner = {
    async attach(id: ConversationId, sessionId: string, identity = String(id)) {
      const provider = await harness.snapshot(
        ProviderDoc,
        id,
        BACKGROUND_CONTEXT,
      );
      if (!provider)
        throw new Error("Durable conversation has no provider session");
      conversations.set(id, {
        sessionId,
        identity,
        providerId: provider.sessionId,
      });
      owners.set(provider.sessionId, owner);
      if (!telemetryStatus().enabled) return undefined;
      let observer = observers.get(id);
      if (!observer) {
        observer = createPiLangfuseDurableConversation(runtime, {
          harness,
          conversationId: id,
          sessionId,
          traceName: agentName,
          context: BACKGROUND_CONTEXT,
          captureContent: telemetryStatus().includeContent,
          generations: "provider",
          metadata: { "gen_ai.conversation.id": identity },
          beforeRun: async (inputs) => {
            await prepareRun(id, inputs);
          },
          onError: (stage) => {
            console.error(`Pi tracing: ${stage}`);
          },
        });
        observers.set(id, observer);
      }
      return observer;
    },
    async submit(
      conversation: Pick<ConversationHandle, "id" | "submit">,
      input: Parameters<ConversationHandle["submit"]>[0],
      execution: ExecutionContext,
    ) {
      const requestId = input.requestId ?? randomUUID();
      if (telemetryStatus().enabled)
        origins.set(
          requestId,
          withoutRequestSession(agentTraceContext(context.active())),
        );
      try {
        return await conversation.submit({ ...input, requestId }, execution);
      } catch (error) {
        origins.delete(requestId);
        throw error;
      }
    },
    async prepareGeneration(api: HookApi, execution: ExecutionContext) {
      const live = await api.snapshot(LiveDoc, api.conversationId, execution);
      if (!live?.run) throw new Error("Model request has no Durable run");
      const run = await prepareRun(api.conversationId, live.run.inputs);
      run.span?.setAttribute("home_agent.task.id", String(api.taskId));
      if (execution.abortSignal) modelParents.set(execution.abortSignal, run);
    },
    async prepareCompaction(
      task: CompactionInvocation[0],
      api: CompactionInvocation[1],
      execution: CompactionInvocation[2],
    ) {
      const live = await api.snapshot(LiveDoc, api.conversationId, execution);
      const run =
        task.owner !== undefined && live?.run?.taskId === task.owner
          ? await prepareRun(api.conversationId, live.run.inputs)
          : undefined;
      return {
        parent: run?.executionContext() ?? ROOT_CONTEXT,
        correlation: run?.correlation ?? correlation(api.conversationId),
      };
    },
    async prepareTool(
      call: ToolHookCall,
      api: HookApi,
      execution: ExecutionContext,
    ) {
      const live = await api.snapshot(LiveDoc, api.conversationId, execution);
      if (!live?.run) throw new Error("Tool request has no Durable run");
      const run = await prepareRun(api.conversationId, live.run.inputs);
      ensureTool(
        api.conversationId,
        api.taskId,
        call.id,
        call.name,
        call.arguments,
        run,
        call.parent,
      );
    },
    tool(api: ToolExecutionApi) {
      return tools.get(`${api.conversationId}:${api.taskId}:${api.callId}`);
    },
    async detach(id: ConversationId) {
      const observer = observers.get(id);
      observers.delete(id);
      await (await observer)?.dispose();
      const conversation = conversations.get(id);
      if (conversation) owners.delete(conversation.providerId);
      conversations.delete(id);
    },
    async close() {
      await runtime.shutdown();
      for (const run of runs.values())
        run
          .update({
            level: "WARNING",
            metadata: { "pi.durable.observation_incomplete": true },
          })
          .end();
      for (const tool of tools.values()) tool.end();
      for (const conversation of conversations.values())
        owners.delete(conversation.providerId);
      runs.clear();
      tools.clear();
      origins.clear();
      inputParents.clear();
      conversations.clear();
      observers.clear();
    },
  };
  return owner;
}
