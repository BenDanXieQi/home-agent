import {
  context,
  propagation,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  NoopSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { genAiContextAttributes } from "./gen-ai";
import { requestSession, traceSessionId } from "./session";

const attribute = "home_agent.trace.agent";
const baggageKey = "home-agent-agent-trace";
const agentSpans = new WeakSet<Span>();

function markSpan(span: Span) {
  agentSpans.add(span);
  span.setAttribute(attribute, true);
}

function markContext(parent: Context) {
  const baggage = propagation.getBaggage(parent) ?? propagation.createBaggage();
  return propagation.setBaggage(
    parent,
    baggage.setEntry(baggageKey, { value: "true" }),
  );
}

/** An application execution boundary, independent of sampling and export destinations. */
export function withAgentTrace<T>(run: () => T) {
  const parent = context.active();
  const span = trace.getSpan(parent);
  if (span) markSpan(span);
  return context.with(markContext(parent), run);
}

/** Restore the marker when durable work restores a span without its original baggage. */
export function agentTraceContext(parent: Context) {
  const span = trace.getSpan(parent);
  return span && agentSpans.has(span) ? markContext(parent) : parent;
}

/** Enrich all destinations equally; only the Langfuse processor filters records. */
export class AgentTraceMarker extends NoopSpanProcessor {
  override onStart(...args: Parameters<SpanProcessor["onStart"]>) {
    const [span, parent] = args;
    const parentSpan = trace.getSpan(parent);
    const sessionId =
      traceSessionId(span.attributes["session.id"]) ??
      traceSessionId(genAiContextAttributes(parent)["session.id"]) ??
      requestSession(parent)?.id;
    if (sessionId) span.setAttribute("session.id", sessionId);
    if (
      span.attributes[attribute] === true ||
      typeof span.attributes["gen_ai.operation.name"] === "string" ||
      typeof span.attributes["gen_ai.agent.name"] === "string" ||
      (parentSpan && agentSpans.has(parentSpan)) ||
      propagation.getBaggage(parent)?.getEntry(baggageKey)?.value === "true"
    )
      markSpan(span);
  }
}

/** Native batching owns the queue, export, flushing and shutdown. */
export class LangfuseAgentSpanProcessor extends BatchSpanProcessor {
  override onEnd(span: Parameters<SpanProcessor["onEnd"]>[0]) {
    if (span.attributes[attribute] === true) super.onEnd(span);
  }
}
