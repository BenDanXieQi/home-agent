import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  ConversationBusy,
  type ConversationHandle,
} from "@earendil-works/pi-durable";
import { AppError } from "@home-agent/api/errors";
import { attemptAsync } from "es-toolkit";

export async function submitConversationInput(
  conversation: Pick<ConversationHandle, "submit" | "abort">,
  content: Parameters<ConversationHandle["submit"]>[0]["content"],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const [submitError, submission] = await attemptAsync(() =>
    conversation.submit(
      { type: "input", content, whenBusy: "reject" },
      context,
    ),
  );
  if (submitError instanceof ConversationBusy)
    throw new AppError("workflow_busy");
  if (submission === null) throw submitError;

  const completion = submission.wait(BACKGROUND_CONTEXT).then((settled) => {
    if (settled.status !== "done" || settled.type !== "input")
      throw new AppError("agent_execution_failed");
  });
  const drained = Promise.allSettled([completion]);
  const [error, completed] = await attemptAsync(() =>
    awaitWithContext(completion, context),
  );
  if (signal.aborted)
    await conversation.abort(BACKGROUND_CONTEXT).finally(() => drained);

  if (completed === null) throw error;
  signal.throwIfAborted();
}
