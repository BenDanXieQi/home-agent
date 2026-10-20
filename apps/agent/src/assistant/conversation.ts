import { attemptAsync } from "es-toolkit";
import { AppError } from "@home-agent/api/errors";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { observeConversationRequest } from "./observation";
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

  async function submitMessage(
    message: string,
    requestSignal: AbortSignal,
    receive?: ReceiveProgress,
  ) {
    requestSignal.throwIfAborted();

    let answer = "";
    await withConversationProgress(
      harness,
      {
        conversation,
        signal: requestSignal,
        onProgress: async (progress) => {
          answer = progress.reply;
          await receive?.(progress);
        },
      },
      async ({ signal, submit }) => {
        signal.throwIfAborted();
        const execution = withAbortSignal(signal, BACKGROUND_CONTEXT);
        const pending = await submit(
          {
            type: "input",
            content: message,
          },
          execution,
        );
        const [error, settled] = await attemptAsync(() =>
          pending.wait(execution),
        );
        if (settled?.status === "done" && settled.type === "input") return;

        if (signal.aborted) await pending.abort(BACKGROUND_CONTEXT);
        if (settled === null) throw error;
        throw new AppError("agent_execution_failed");
      },
    );

    return answer;
  }

  async function submitAndWait(
    message: string,
    requestSignal: AbortSignal,
    receive?: ReceiveProgress,
  ) {
    const [cause, answer] = await attemptAsync(() =>
      submitMessage(message, requestSignal, receive),
    );
    if (answer !== null) return answer;
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
