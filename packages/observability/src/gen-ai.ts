import {
  context,
  createContextKey,
  type Attributes,
  type Context,
} from "@opentelemetry/api";
import { bindTraceSession, sessionBaggageContext } from "./session";

const attributesKey = createContextKey("home-agent.gen-ai");

class GenAiContext {
  constructor(readonly attributes: Attributes) {}
}

export function withGenAiContext<T>(attributes: Attributes, run: () => T) {
  const sessionId = attributes["session.id"];
  if (typeof sessionId === "string") bindTraceSession(sessionId);
  const parent = context.active();
  return context.with(
    (typeof sessionId === "string"
      ? sessionBaggageContext(parent, sessionId)
      : parent
    ).setValue(
      attributesKey,
      new GenAiContext({ ...genAiContextAttributes(), ...attributes }),
    ),
    run,
  );
}

export function genAiContextAttributes(parent: Context = context.active()) {
  const value = parent.getValue(attributesKey);
  return value instanceof GenAiContext ? value.attributes : {};
}
