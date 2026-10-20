import {
  context,
  createContextKey,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { telemetryStatus } from "./telemetry";

const key = createContextKey("home-agent.evaluation");

class Evaluation {
  readonly span;
  private finished = false;
  private readonly generations: { span_id: string; input: unknown }[] = [];
  private readonly tools = new Map<
    string,
    { name: string; arguments: unknown; result?: unknown; status: string }
  >();

  constructor(span: Span, input: unknown) {
    this.span = span;
    span.setAttribute("langfuse.internal.is_app_root", true);
    if (telemetryStatus().includeContent)
      span.setAttribute("langfuse.observation.input", JSON.stringify(input));
  }

  private get recording() {
    return (
      !this.finished &&
      this.span.isRecording() &&
      telemetryStatus().includeContent
    );
  }

  finish() {
    if (this.finished) return;
    try {
      if (this.recording && (this.generations.length || this.tools.size))
        this.span.setAttribute(
          "langfuse.observation.metadata",
          JSON.stringify({
            evaluation_context: {
              generations: this.generations,
              tools: [...this.tools].map(([id, tool]) => ({ id, ...tool })),
            },
          }),
        );
    } catch {
      console.error("Agent tracing: evaluation context serialization failed");
    } finally {
      this.finished = true;
      this.generations.length = 0;
      this.tools.clear();
    }
  }

  model(input: unknown, spanId: string) {
    if (!this.recording) return;
    this.generations.push({
      span_id: spanId,
      input,
    });
  }

  tool(id: string, value: Parameters<Evaluation["tools"]["set"]>[1]) {
    if (!this.recording) return;
    this.tools.set(id, value);
  }

  output(value: unknown) {
    if (this.recording)
      this.span.setAttribute(
        "langfuse.observation.output",
        JSON.stringify(value),
      );
  }
}

class EvaluationTargets {
  readonly values;
  constructor(values: Evaluation[]) {
    this.values = values;
  }
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

export function finishEvaluation(span: Span, parent: Context) {
  targets(parent)
    .find((target) => target.span === span)
    ?.finish();
}

export function withEvaluation<T>(
  span: Span,
  input: unknown,
  run: () => Promise<T>,
) {
  const parent = evaluationContext(span, input, context.active());
  return context.with(parent, async () => {
    try {
      return await run();
    } finally {
      finishEvaluation(span, parent);
    }
  });
}

export function recordEvaluationOutput(output: unknown) {
  targets(context.active()).at(-1)?.output(output);
}

export function recordEvaluationIncomplete(parent: Context) {
  for (const target of targets(parent))
    if (target.span.isRecording())
      target.span.setAttribute("pi.durable.observation_incomplete", true);
}

export function recordEvaluationModel(input: unknown, span: Span) {
  for (const target of targets(context.active()))
    target.model(input, span.spanContext().spanId);
}

export function recordEvaluationTool(...args: Parameters<Evaluation["tool"]>) {
  for (const target of targets(context.active())) target.tool(...args);
}
