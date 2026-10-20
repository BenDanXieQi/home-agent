import {
  telemetryStatus,
  observeAgentOperation,
} from "@home-agent/observability";

type Span = Parameters<
  Parameters<typeof observeAgentOperation>[3]["onStart"]
>[0];

type ObservationProjection = {
  attributes?: Parameters<Span["setAttributes"]>[0];
  // Built only when the span records message content.
  messages?: () => unknown;
};

export function observeWorkflowExecution<Input, Result>(
  name: string,
  observation: {
    // Returning undefined leaves the call without a business operation span.
    start: (input: Input) => ObservationProjection | undefined;
    complete?: (result: Result) => ObservationProjection;
  },
  input: Input,
  execute: () => Promise<Result>,
) {
  const start = observation.start(input);
  if (!start) return execute();

  return observeAgentOperation(name, input, execute, {
    onStart: (span) => {
      record(span, start, "gen_ai.input.messages");
    },
    onComplete: (span, result) => {
      if (observation.complete)
        record(span, observation.complete(result), "gen_ai.output.messages");
      return result;
    },
  });
}

function record(
  span: Span,
  { attributes, messages }: ObservationProjection,
  messageAttribute: string,
) {
  if (attributes) span.setAttributes(attributes);
  if (
    messages !== undefined &&
    span.isRecording() &&
    telemetryStatus().includeContent
  )
    span.setAttribute(messageAttribute, JSON.stringify(messages()));
}
