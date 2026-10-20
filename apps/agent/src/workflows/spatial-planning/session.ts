import { withConversationProgress } from "../../conversation/progress";
import { z } from "zod";
import { memo as once, tryit } from "radash";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
  type Context,
} from "@earendil-works/chord/context";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  ConversationBusy,
  type EntryId,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { AppError } from "@home-agent/api/errors";
import type { WorkflowDependencies } from "../definition";
import { readFinalAnswer } from "../../utils/final-answer";
import { createSpatialPlanningExtension } from "./extension";
import { spatialPlanningContentSchema } from "./extension";
import type { spatialPlanningInputSchema } from "./workflow";
import { conversationProgressSchema } from "../../conversation/contracts";

export const spatialPlanningSnapshotSchema =
  spatialPlanningContentSchema.extend({
    session_id: z.uuid(),
    status: z.enum(["idle", "running"]),
  });

export const spatialPlanningResultSchema = z.discriminatedUnion("status", [
  spatialPlanningSnapshotSchema,
  z.strictObject({ session_id: z.uuid(), status: z.literal("closed") }),
]);

export const spatialPlanningProgressSchema = conversationProgressSchema.extend({
  ...spatialPlanningContentSchema.omit({ reply: true }).shape,
});

type PlanningMessage = Extract<
  z.infer<typeof spatialPlanningInputSchema>,
  { action: "message" }
>;

type ReceiveProgress = (
  progress: z.infer<typeof spatialPlanningProgressSchema>,
) => Promise<void>;

function turnContent(
  {
    questions,
    draft,
  }: Pick<z.infer<typeof spatialPlanningContentSchema>, "questions" | "draft">,
  input: PlanningMessage,
) {
  return [
    {
      type: "text",
      text: `当前空间规划状态：\n${JSON.stringify({ questions, draft })}`,
    },
    {
      type: "text",
      text: input.text || "请分析这张图片中的空间和通道关系。",
    },
    ...input.images.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mime_type,
    })),
  ] satisfies Exclude<UserMessage["content"], string>;
}

export async function createSpatialPlanningSession(
  {
    harness,
    model,
    contextReader,
  }: Pick<WorkflowDependencies, "harness" | "model" | "contextReader">,
  initialDraft:
    | z.infer<typeof spatialPlanningContentSchema>["draft"]
    | undefined,
  creationSignal: AbortSignal,
) {
  const mijiaRooms = (await contextReader.readRooms(creationSignal)).map((room) => room.name);
  const { SpatialPlanningDoc, SpatialPlanningExtension } =
    createSpatialPlanningExtension();

  const conversation = await harness.createConversation(
    {
      agentName: "spatial-planning",
      ownership: { kind: "ownerless" },
      agent: {
        model: { provider: model.provider, modelId: model.id },
        extensions: [SpatialPlanningExtension],
      },
      init: async (tx, id) => {
        const state = await tx.doc(SpatialPlanningDoc, id);
        state.mijiaRooms = mijiaRooms;
        if (initialDraft) state.draft = initialDraft;
      },
    },
    withAbortSignal(creationSignal, BACKGROUND_CONTEXT),
  );
  const { sessionId } = conversation;
  let closed = false;
  let messageInFlight = false;
  const dispose = once(() => {
    closed = true;
    return conversation.close();
  });

  async function readState(context: Context, answerId: EntryId) {
    return conversation.commit(async (tx) => {
      const { questions, draft } = await tx.doc(
        SpatialPlanningDoc,
        conversation.id,
      );
      const entry = await tx.entry(AssistantEntry, answerId);
      const assistantMessage = entry?.model?.[0];
      const reply = readFinalAnswer(
        assistantMessage?.role === "assistant" ? assistantMessage : undefined,
      );
      const live = await tx.doc(LiveDoc, conversation.id);
      return spatialPlanningSnapshotSchema.parse({
        reply,
        questions,
        draft,
        session_id: sessionId,
        status: live.run ? "running" : "idle",
      });
    }, context);
  }

  async function submitTurn(
    input: PlanningMessage,
    {
      signal,
      submit,
    }: Parameters<Parameters<typeof withConversationProgress>[2]>[0],
  ) {
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const content = await conversation.commit(async (tx) => {
      const state = await tx.doc(SpatialPlanningDoc, conversation.id);
      return turnContent(state, input);
    }, context);
    if (closed) throw new AppError("not_found");
    const [submitError, submission] = await tryit(() =>
      submit({ type: "input", content, whenBusy: "reject" }, context),
    )();
    if (submission === undefined) {
      if (submitError instanceof ConversationBusy)
        throw new AppError("workflow_busy");
      throw submitError;
    }
    const completion = submission.wait(BACKGROUND_CONTEXT).then((settled) => {
      if (settled.status !== "done" || settled.type !== "input")
        throw new AppError("agent_execution_failed");
      return readState(BACKGROUND_CONTEXT, settled.answer);
    });
    const drained = Promise.allSettled([completion]);
    const [error, snapshot] = await tryit(awaitWithContext)(
      completion,
      context,
    );
    if (signal.aborted) {
      await conversation.abort(BACKGROUND_CONTEXT).finally(() => drained);
      if (snapshot !== undefined) signal.throwIfAborted();
    }
    if (snapshot === undefined) throw error;
    return snapshot;
  }

  async function message(
    input: PlanningMessage,
    requestSignal: AbortSignal,
    receive?: ReceiveProgress,
  ) {
    if (closed) throw new AppError("not_found");
    if (messageInFlight) throw new AppError("workflow_busy");
    if (input.images.length > 0 && !model.input.includes("image"))
      throw new AppError("invalid_request");
    messageInFlight = true;
    try {
      return await withConversationProgress(
        harness,
        {
          conversation,
          signal: requestSignal,
          stateDoc: SpatialPlanningDoc,
          onProgress: receive
            ? async (progress, state) => {
                if (!state) throw new AppError("agent_execution_failed");
                await receive({
                  questions: state.questions,
                  draft: state.draft,
                  ...progress,
                });
              }
            : undefined,
        },
        (execution) => submitTurn(input, execution),
      );
    } finally {
      messageInFlight = false;
    }
  }

  async function close(signal: AbortSignal) {
    await dispose();
    signal.throwIfAborted();
    return { session_id: sessionId, status: "closed" as const };
  }

  return {
    sessionId,
    message: (
      input: PlanningMessage,
      signal: AbortSignal,
      receive?: ReceiveProgress,
    ) => conversation.withTraceContext(() => message(input, signal, receive)),
    close: (signal: AbortSignal) =>
      conversation.withTraceContext(() => close(signal)),
    dispose,
  };
}
