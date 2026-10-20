import { recordEvaluationOutput, withEvaluation } from "./evaluation";
import { withSpan, type Span } from "./spans";

export function observeAgentOperation<Result>(
  name: string,
  input: unknown,
  execute: () => Promise<Result>,
  callbacks: {
    onStart: (span: Span) => void;
    onComplete: (span: Span, result: Result) => unknown;
  },
) {
  return withSpan(`${name}.run`, { "gen_ai.agent.name": name }, (span) =>
    withEvaluation(span, input, async () => {
      callbacks.onStart(span);

      const result = await execute();

      recordEvaluationOutput(callbacks.onComplete(span, result));
      return result;
    }),
  );
}
