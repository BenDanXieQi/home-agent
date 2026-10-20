import { tryit } from "radash";
import { AppError } from "@home-agent/api/errors";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { AssistantEntry, type EntryId } from "@earendil-works/pi-durable";
import { observeConversationRequest } from "./observation";
import { readFinalAnswer } from "../utils/final-answer";
import type { configureAssistant } from "./assistant";
import type { z } from "zod";
import type { chatStreamContract } from "./contracts";
import { withConversationProgress } from "../conversation/progress";

type ReceiveProgress = (
  progress: z.infer<typeof chatStreamContract.progress>,
) => Promise<void>;

export function createConversationInteraction(
  conversation: Pick<
    NonNullable<
      ReturnType<ReturnType<typeof configureAssistant>["register"]>["instance"]
    >,
    "id" | "commit" | "sessionId" | "submit"
  >,
  harness: Parameters<typeof withConversationProgress>[0],
) {
  const { sessionId } = conversation;
  async function readAnswer(answerId: EntryId, signal: AbortSignal) {
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const entry = await conversation.commit(
      (tx) => tx.entry(AssistantEntry, answerId),
      context,
    );
    const assistantMessage = entry?.model?.[0];
    const text = readFinalAnswer(
      assistantMessage?.role === "assistant" ? assistantMessage : undefined,
    );

    signal.throwIfAborted();
    return text;
  }

  async function submitAndReadAnswer(
    message: string,
    requestSignal: AbortSignal,
    receive?: ReceiveProgress,
  ) {
    requestSignal.throwIfAborted();
    return withConversationProgress(
      harness,
      {
        conversation,
        signal: requestSignal,
        onProgress: receive,
      },
      async ({ signal, submit }) => {
        signal.throwIfAborted();
        const pending = await submit(
          { type: "input", content: message },
          BACKGROUND_CONTEXT,
        );
        try {
          const settled = await pending.wait(
            withAbortSignal(signal, BACKGROUND_CONTEXT),
          );
          if (settled.status !== "done" || settled.type !== "input")
            throw new AppError("agent_execution_failed");
          return await readAnswer(settled.answer, signal);
        } catch (error) {
          if (signal.aborted) await pending.abort(BACKGROUND_CONTEXT);
          throw error;
        }
      },
    );
  }

  async function submitAndWait(
    message: string,
    requestSignal: AbortSignal,
    receive?: ReceiveProgress,
  ) {
    const [cause, answer] = await tryit(submitAndReadAnswer)(
      message,
      requestSignal,
      receive,
    );
    if (!cause) return answer;
    if (requestSignal.aborted)
      throw new AppError("request_cancelled", { cause });
    throw new AppError("agent_execution_failed", { cause });
  }

  return {
    submitAndWait: (
      message: string,
      signal: AbortSignal,
      receive?: ReceiveProgress,
    ) =>
      observeConversationRequest(
        {
          message,
          sessionId,
          conversationId: conversation.id,
        },
        () => submitAndWait(message, signal, receive),
      ),
  };
}
