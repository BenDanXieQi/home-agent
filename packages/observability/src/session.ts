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

  constructor(private span: Span | undefined) {}

  bind(id: string) {
    if (this.closed) return;
    if (this.id !== undefined && this.id !== id) return;
    this.id = id;
    if (this.span?.isRecording()) this.span.setAttribute("session.id", id);
  }

  close() {
    this.closed = true;
    this.span = undefined;
  }
}

export function requestSession(parent = context.active()) {
  const value = parent.getValue(key);
  return value instanceof RequestSession ? value : undefined;
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

/** Bind only an application-confirmed session; it is correlation, not authorization. */
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

/** A fresh holder lets the HTTP response return a session discovered by its handler. */
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

/** Durable work keeps immutable correlation and must not retain an HTTP holder. */
export function withoutRequestSession(parent: Context) {
  return sessionBaggageContext(
    parent.deleteValue(key),
    currentTraceSessionId(parent),
  );
}
