import {
  context,
  createContextKey,
  propagation,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";

const key = createContextKey("home-agent.request-session");
const baggageKey = "home-agent-session-id";
export const sessionResponseHeader = "x-home-agent-session-id";

export function traceSessionId(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[\x21-\x7e]+$/.test(value)
    ? value
    : undefined;
}

class RequestSession {
  id: string | undefined;
  private closed = false;
  private readonly spans = new Set<Span>();
  completion: Promise<void> | undefined;

  constructor(span: Span | undefined) {
    if (span) this.spans.add(span);
  }

  attach(span: Span) {
    this.spans.add(span);
    if (this.id) span.setAttribute("session.id", this.id);
  }

  detach(span: Span) {
    this.spans.delete(span);
  }

  holdUntil(completion: Promise<void>) {
    this.completion = completion;
  }

  bind(id: string) {
    if (this.closed) return;
    if (this.id !== undefined && this.id !== id) return;
    this.id = id;
    for (const span of this.spans)
      if (span.isRecording()) span.setAttribute("session.id", id);
  }

  close() {
    this.closed = true;
    this.spans.clear();
  }
}

export function requestSession(parent = context.active()) {
  const value = parent.getValue(key);
  return value instanceof RequestSession ? value : undefined;
}

export function trackHttpStream(completion: Promise<void>) {
  requestSession()?.holdUntil(completion);
}

export function currentTraceSessionId(parent = context.active()) {
  return (
    requestSession(parent)?.id ??
    traceSessionId(propagation.getBaggage(parent)?.getEntry(baggageKey)?.value)
  );
}

export function sessionBaggageContext(parent: Context, id?: string) {
  let baggage = propagation.getBaggage(parent) ?? propagation.createBaggage();
  baggage = baggage.removeEntry(baggageKey);
  const sessionId = traceSessionId(id);
  if (sessionId) baggage = baggage.setEntry(baggageKey, { value: sessionId });
  return propagation.setBaggage(parent, baggage);
}

export function bindTraceSession(value: string) {
  const id = traceSessionId(value);
  if (!id) return;
  const parent = context.active();
  const session = requestSession(parent);
  if (session?.id !== undefined && session.id !== id) return;
  session?.bind(id);
  const span = trace.getSpan(parent);
  if (span?.isRecording()) span.setAttribute("session.id", id);
}

export function withRequestSession<T>(
  acceptIncoming: boolean,
  run: (session: RequestSession) => Promise<T>,
) {
  const parent = context.active();
  const session = new RequestSession(trace.getSpan(parent));
  const id = acceptIncoming ? currentTraceSessionId(parent) : undefined;
  if (id) session.bind(id);
  return context.with(
    sessionBaggageContext(parent, id).setValue(key, session),
    async () => {
      try {
        return await run(session);
      } finally {
        session.close();
      }
    },
  );
}

export function withoutRequestSession(parent: Context) {
  return sessionBaggageContext(
    parent.deleteValue(key),
    currentTraceSessionId(parent),
  );
}
