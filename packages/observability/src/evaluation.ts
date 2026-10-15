import {
  context,
  createContextKey,
  type Context,
  type Span,
} from "@opentelemetry/api";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { telemetryStatus } from "./telemetry";
import { genAiMessages, genAiToolDefinitions } from "./messages";

const key = createContextKey("home-agent.evaluation");

class Evaluation {
  private readonly generations: Array<{
    span_id: string;
    messages: ReturnType<typeof genAiMessages>;
    tool_definitions: ReturnType<typeof genAiToolDefinitions>;
  }> = [];
  private readonly tools = new Map<
    string,
    { name: string; arguments: unknown; result?: unknown; status: string }
  >();

  constructor(
    readonly span: Span,
    input: unknown,
  ) {
    span.setAttribute("langfuse.internal.is_app_root", true);
    if (telemetryStatus().includeContent)
      span.setAttribute("langfuse.observation.input", JSON.stringify(input));
  }

  private publish() {
    if (!this.span.isRecording() || !telemetryStatus().includeContent) return;
    this.span.setAttribute(
      "langfuse.observation.metadata",
      JSON.stringify({
        evaluation_context: {
          generations: this.generations,
          tools: [...this.tools].map(([id, tool]) => ({ id, ...tool })),
        },
      }),
    );
  }

  model(transcript: TranscriptContext, spanId: string) {
    if (!this.span.isRecording() || !telemetryStatus().includeContent) return;
    this.generations.push({
      span_id: spanId,
      messages: genAiMessages(transcript.messages),
      tool_definitions: genAiToolDefinitions(transcript.messages),
    });
    this.publish();
  }

  tool(
    id: string,
    value: {
      name: string;
      arguments: unknown;
      result?: unknown;
      status: string;
    },
  ) {
    if (!this.span.isRecording() || !telemetryStatus().includeContent) return;
    this.tools.set(id, value);
    this.publish();
  }

  output(value: unknown) {
    if (this.span.isRecording() && telemetryStatus().includeContent)
      this.span.setAttribute(
        "langfuse.observation.output",
        JSON.stringify(value),
      );
  }
}

class EvaluationTargets {
  constructor(readonly values: Evaluation[]) {}
}

class CombinedEvaluationTargets extends EvaluationTargets {}

function targets(parent: Context) {
  const value = parent.getValue(key);
  return value instanceof EvaluationTargets ? value.values : [];
}

export function evaluationContext(span: Span, input: unknown, parent: Context) {
  return parent.setValue(
    key,
    new EvaluationTargets([...targets(parent), new Evaluation(span, input)]),
  );
}

export function combineEvaluationContexts(parents: Context[], base: Context) {
  const current = base.getValue(key);
  const combined =
    current instanceof CombinedEvaluationTargets
      ? current
      : new CombinedEvaluationTargets([...targets(base)]);
  for (const value of parents.flatMap(targets))
    if (!combined.values.includes(value)) combined.values.push(value);
  return base.setValue(key, combined);
}

export function hasEvaluationContext(parent: Context) {
  return targets(parent).length > 0;
}

export function withEvaluation<T>(span: Span, input: unknown, run: () => T) {
  return context.with(evaluationContext(span, input, context.active()), run);
}

export function recordEvaluationOutput(output: unknown) {
  targets(context.active()).at(-1)?.output(output);
}

export function recordEvaluationModel(
  transcript: TranscriptContext,
  span: Span,
) {
  for (const target of targets(context.active()))
    target.model(transcript, span.spanContext().spanId);
}

export function recordEvaluationTool(...args: Parameters<Evaluation["tool"]>) {
  for (const target of targets(context.active())) target.tool(...args);
}
