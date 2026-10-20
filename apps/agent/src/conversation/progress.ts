import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import type { Draft } from "@earendil-works/chord";
import { cloneDeep, pick } from "es-toolkit";
import {
  AssistantEntry,
  LiveDoc,
  type ConversationDocToken,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { AppError } from "@home-agent/api/errors";
import type { z } from "zod";
import type { createAgentHarness } from "../harness";
import type { conversationProgressSchema } from "./contracts";
import { readFinalAnswer } from "../utils/final-answer";

type Conversation = Pick<
  Awaited<
    ReturnType<ReturnType<typeof createAgentHarness>["createConversation"]>
  >,
  "id" | "sessionId" | "submit" | "commit"
>;

type Submission = Awaited<ReturnType<Conversation["submit"]>>;

type ReceiveProgress<State extends unknown[]> = (
  progress: z.infer<typeof conversationProgressSchema>,
  ...state: State
) => Promise<void>;

export async function withConversationProgress<
  State extends JsonObject,
  Result,
>(
  harness: Pick<ReturnType<typeof createAgentHarness>, "watchDoc">,
  options: {
    conversation: Conversation;
    signal: AbortSignal;
  } & (
    | {
        stateDoc: ConversationDocToken<State>;
        onProgress?: ReceiveProgress<[Readonly<Draft<State>>]> | undefined;
      }
    | {
        stateDoc?: undefined;
        onProgress?: ReceiveProgress<[]> | undefined;
      }
  ),
  execute: (execution: {
    signal: AbortSignal;
    submit: Conversation["submit"];
  }) => Promise<Result>,
) {
  const { conversation, signal: requestSignal, stateDoc, onProgress } = options;

  let submission: Submission | undefined;
  async function submit(...args: Parameters<Conversation["submit"]>) {
    submission = await conversation.submit(...args);
    return submission;
  }

  if (!onProgress) return execute({ signal: requestSignal, submit });

  const deliverProgress = async (
    progress: z.infer<typeof conversationProgressSchema>,
    state: Readonly<Draft<State>> | undefined,
  ) => {
    if (!stateDoc) return onProgress(progress);
    if (state === undefined) throw new AppError("agent_execution_failed");

    return onProgress(progress, state);
  };

  const deliveryController = new AbortController();
  const signal = AbortSignal.any([requestSignal, deliveryController.signal]);
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);

  const pendingDeliveries = new Set<Promise<unknown>>();
  await using resources = new AsyncDisposableStack();

  resources.defer(async () => {
    await Promise.all(pendingDeliveries);
  });

  async function watchDoc<Doc extends JsonObject>(
    token: ConversationDocToken<Doc>,
  ) {
    const watch = await harness.watchDoc(token, conversation.id, context);
    return resources.adopt(watch, async (handle) => {
      await handle?.stop();
    });
  }

  const liveWatch = await watchDoc(LiveDoc);
  const stateWatch = stateDoc ? await watchDoc(stateDoc) : undefined;
  if (!liveWatch || (stateDoc && !stateWatch))
    throw new AppError("agent_execution_failed");

  let reply = "";
  const sendProgress = async () => {
    signal.throwIfAborted();

    const snapshot = await conversation.commit(async (tx) => {
      const liveState = await tx.doc(LiveDoc, conversation.id);
      if (!submission || !liveState.run?.inputs.includes(submission.id))
        return null;

      const partialMessage = liveState.generation?.message;
      if (partialMessage) reply = contentText(partialMessage.content, "");

      const progress = {
        session_id: conversation.sessionId,
        reply,
        tools: (liveState.tools ?? []).map((tool) =>
          pick(tool, ["callId", "name", "status"]),
        ),
      } satisfies z.infer<typeof conversationProgressSchema>;
      const state = stateDoc
        ? cloneDeep(await tx.doc(stateDoc, conversation.id))
        : undefined;

      return { progress, state };
    }, context);
    if (!snapshot) return null;

    await deliverProgress(snapshot.progress, snapshot.state);
    return snapshot.progress;
  };

  async function onDocumentChange() {
    const sending = sendProgress().catch((error: unknown) => {
      deliveryController.abort(error);
    });
    pendingDeliveries.add(sending);

    await sending;
    pendingDeliveries.delete(sending);
  }

  liveWatch.start(onDocumentChange);
  stateWatch?.start(onDocumentChange);

  signal.throwIfAborted();
  const initialState = stateDoc
    ? await conversation.commit(
        async (tx) => cloneDeep(await tx.doc(stateDoc, conversation.id)),
        context,
      )
    : undefined;
  await deliverProgress(
    { session_id: conversation.sessionId, reply: "", tools: [] },
    initialState,
  );

  const result = await execute({ signal, submit });
  await resources.disposeAsync();
  signal.throwIfAborted();

  if (!submission) return result;
  const settled = await submission.wait(context);
  if (settled.type !== "input" || settled.status !== "done") return result;

  const snapshot = await conversation.commit(async (tx) => {
    const entry = await tx.entry(AssistantEntry, settled.answer);
    const message = entry?.model?.[0];
    return {
      reply: readFinalAnswer(
        message?.role === "assistant" ? message : undefined,
      ),
      state: stateDoc
        ? cloneDeep(await tx.doc(stateDoc, conversation.id))
        : undefined,
    };
  }, context);
  await deliverProgress(
    {
      session_id: conversation.sessionId,
      reply: snapshot.reply,
      tools: [],
    },
    snapshot.state,
  );
  signal.throwIfAborted();

  return result;
}
