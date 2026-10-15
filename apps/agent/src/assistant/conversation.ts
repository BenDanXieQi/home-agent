import { partial, tryit } from "radash";
import { AppError } from "@home-agent/api/errors";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";
import {
  telemetryStatus,
  withEvaluation,
  withGenAiContext,
  withSpan,
  recordEvaluationOutput,
} from "@home-agent/observability";
import { readFinalAnswer } from "../utils/final-answer";
import type { createAssistant } from "./assistant";

export function createConversationInteraction(
  conversation: NonNullable<
    Awaited<ReturnType<typeof createAssistant>>
  >["root"],
  options: {
    sessionId: string;
    timeoutMs: number;
    tracing: NonNullable<
      Awaited<ReturnType<typeof createAssistant>>
    >["tracing"];
  },
) {
  async function readAndRecordAnswer(
    submission: Awaited<ReturnType<typeof options.tracing.submit>>,
    signal: AbortSignal,
    span: Parameters<typeof withEvaluation>[0],
  ) {
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const settled = await submission.wait(context);
    signal.throwIfAborted();
    if (settled.status !== "done" || settled.type !== "input")
      throw new Error("The agent execution did not complete");
    const entry = await conversation.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      context,
    );
    const assistantMessage = entry?.model?.[0];
    const text = readFinalAnswer(
      assistantMessage?.role === "assistant" ? assistantMessage : undefined,
    );
    signal.throwIfAborted();
    recordEvaluationOutput({ answer: text });
    recordMessage(span, "assistant", text);
    return text;
  }

  async function submitAndReadAnswer(
    message: string,
    requestSignal: AbortSignal,
    span: Parameters<typeof withEvaluation>[0],
  ) {
    requestSignal.throwIfAborted();
    const signal = AbortSignal.any([
      requestSignal,
      AbortSignal.timeout(options.timeoutMs),
    ]);
    recordMessage(span, "user", message);

    const submission = await options.tracing.submit(
      conversation,
      { type: "input", content: message },
      BACKGROUND_CONTEXT,
    );
    span.setAttribute("home_agent.submission.id", String(submission.id));

    return readAndRecordAnswer(submission, signal, span).catch(
      async (error) => {
        // Cancelling a waiter may withdraw its queued input, but does not stop other work.
        if (signal.aborted) await submission.abort(BACKGROUND_CONTEXT);
        throw error;
      },
    );
  }

  async function run(message: string, requestSignal: AbortSignal) {
    const runWithEvaluation = (span: Parameters<typeof withEvaluation>[0]) =>
      withEvaluation(
        span,
        { task: message },
        partial(submitAndReadAnswer, message, requestSignal, span),
      );
    const answer = await withGenAiContext(
      {
        "session.id": options.sessionId,
        "gen_ai.conversation.id": String(conversation.id),
      },
      () =>
        withSpan(
          "household-assistant.run",
          { "gen_ai.agent.name": "household-assistant" },
          runWithEvaluation,
        ),
    );
    requestSignal.throwIfAborted();
    return answer;
  }

  async function submitAndWait(message: string, requestSignal: AbortSignal) {
    const [cause, answer] = await tryit(run)(message, requestSignal);
    if (!cause) return answer;
    if (requestSignal.aborted)
      throw new AppError("request_cancelled", { cause });
    if (cause instanceof DOMException && cause.name === "TimeoutError")
      throw new AppError("run_timeout", { cause });
    throw new AppError("agent_execution_failed", { cause });
  }

  return { submitAndWait };
}

function recordMessage(
  span: Parameters<typeof withEvaluation>[0],
  role: "user" | "assistant",
  content: string,
) {
  if (!span.isRecording() || !telemetryStatus().includeContent) return;
  const attribute =
    role === "user" ? "gen_ai.input.messages" : "gen_ai.output.messages";
  span.setAttribute(
    attribute,
    JSON.stringify([{ role, parts: [{ type: "text", content }] }]),
  );
}
