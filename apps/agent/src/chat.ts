import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { chatInputSchema, chatResponseSchema } from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import type { z } from "zod";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { telemetryStatus, recordFailure } from "@home-agent/observability";
import { completeAnswer, type createAssistant } from "./assistant";

export function createChat(
  assistant: Awaited<ReturnType<typeof createAssistant>>,
  timeoutMs: number,
) {
  if (!assistant) return undefined;
  return async (
    input: z.infer<typeof chatInputSchema>,
    requestSignal: AbortSignal,
  ) => {
    try {
      const answer = await propagateAttributes(
        { sessionId: assistant.sessionId },
        async () => {
          const observation = startObservation("household-assistant.wait", {
            metadata: { conversationId: assistant.root.id },
          });
          const span = observation.otelSpan;
          try {
            requestSignal.throwIfAborted();
            const signal = AbortSignal.any([
              requestSignal,
              AbortSignal.timeout(timeoutMs),
            ]);
            if (span.isRecording() && telemetryStatus().includeContent)
              observation.update({ input: input.message });
            const submission = await assistant.root.submit(
              { type: "input", content: input.message },
              BACKGROUND_CONTEXT,
            );
            observation.update({ metadata: { submissionId: submission.id } });
            try {
              const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
              const settled = await submission.wait(context);
              signal.throwIfAborted();
              if (settled.status !== "done" || settled.type !== "input")
                throw new Error("The agent execution did not complete");
              const entry = await assistant.root.commit(
                (tx) => tx.entry(AssistantEntry, settled.answer),
                context,
              );
              const message = entry?.model?.[0];
              const text = completeAnswer(
                message?.role === "assistant" ? message : undefined,
              );
              signal.throwIfAborted();
              if (span.isRecording() && telemetryStatus().includeContent)
                observation.update({ output: text });
              return text;
            } catch (error) {
              // Cancelling a waiter may withdraw its queued input, but does not stop other work.
              if (signal.aborted) await submission.abort(BACKGROUND_CONTEXT);
              throw error;
            }
          } catch (error) {
            recordFailure(span, error);
            throw error;
          } finally {
            observation.end();
          }
        },
      );
      requestSignal.throwIfAborted();
      return chatResponseSchema.parse({ answer });
    } catch (cause) {
      throw new AppError(
        requestSignal.aborted
          ? "request_cancelled"
          : cause instanceof DOMException && cause.name === "TimeoutError"
            ? "run_timeout"
            : "agent_execution_failed",
        { cause },
      );
    }
  };
}
