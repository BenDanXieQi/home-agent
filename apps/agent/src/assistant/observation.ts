import {
  observeAgentOperation,
  telemetryStatus,
  withGenAiContext,
  type Span,
} from "@home-agent/observability";

export function observeConversationRequest(
  input: { message: string; sessionId: string; conversationId: number },
  execute: () => Promise<string>,
) {
  return withGenAiContext(
    {
      "session.id": input.sessionId,
      "gen_ai.conversation.id": String(input.conversationId),
    },
    () =>
      observeAgentOperation(
        "household-assistant",
        { task: input.message },
        execute,
        {
          onStart: (span) => {
            recordMessage(span, "user", input.message);
          },
          onComplete: (span, answer) => {
            recordMessage(span, "assistant", answer);
            return { answer };
          },
        },
      ),
  );
}

function recordMessage(
  span: Span,
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
