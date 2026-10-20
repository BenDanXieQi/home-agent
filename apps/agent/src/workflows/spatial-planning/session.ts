import { withConversationProgress } from "../../conversation/progress";
import { z } from "zod";
import { attemptAsync, memoize } from "es-toolkit";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
  type Context,
} from "@earendil-works/chord/context";
import { ConversationBusy, LiveDoc } from "@earendil-works/pi-durable";
import { AppError } from "@home-agent/api/errors";
import type { WorkflowDependencies } from "../definition";
import {
  SpatialPlanningDoc,
  SpatialPlanningExtension,
  spatialPlanningStateSchema,
  spatialPlanningPromptName,
} from "./extension";
import type { spatialPlanningInputSchema } from "./workflow";
import { conversationProgressSchema } from "../../conversation/contracts";

export const spatialPlanningSnapshotSchema = spatialPlanningStateSchema.extend({
  session_id: z.uuid(),
  status: z.enum(["idle", "running"]),
});

export const spatialPlanningResultSchema = z.discriminatedUnion("status", [
  spatialPlanningSnapshotSchema,
  z.strictObject({ session_id: z.uuid(), status: z.literal("closed") }),
]);

export const spatialPlanningProgressSchema = conversationProgressSchema.extend({
  ...spatialPlanningStateSchema.shape,
});

type PlanningMessage = Extract<
  z.infer<typeof spatialPlanningInputSchema>,
  { action: "message" }
>;

type ReceiveProgress = (
  progress: z.infer<typeof spatialPlanningProgressSchema>,
) => Promise<void>;

export async function createSpatialPlanningSession({
  dependencies: { harness, model, contextReader },
  initialDraft,
  signal: creationSignal,
}: {
  dependencies: Pick<
    WorkflowDependencies,
    "harness" | "model" | "contextReader"
  >;
  initialDraft?:
    | z.infer<typeof spatialPlanningStateSchema>["draft"]
    | undefined;
  signal: AbortSignal;
}) {
  const mijiaRooms = (await contextReader.readRooms(creationSignal)).map(
    (room) => room.name,
  );

  const conversation = await harness.createConversation(
    {
      agentName: "spatial-planning",
      prompt: {
        name: spatialPlanningPromptName,
        systemVariables: { mijia_rooms: JSON.stringify(mijiaRooms) },
        userVariables: async (currentConversation, context) =>
          currentConversation.commit(async (tx) => {
            const state = await tx.doc(
              SpatialPlanningDoc,
              currentConversation.id,
            );
            return {
              draft: JSON.stringify(state.draft),
              questions: JSON.stringify(state.questions),
            };
          }, context),
      },
      ownership: { kind: "ownerless" },
      agent: {
        model: { provider: model.provider, modelId: model.id },
        extensions: [SpatialPlanningExtension],
      },
      init: async (tx, id) => {
        const state = await tx.doc(SpatialPlanningDoc, id);
        if (initialDraft) state.draft = initialDraft;
      },
    },
    withAbortSignal(creationSignal, BACKGROUND_CONTEXT),
  );
  const { sessionId } = conversation;
  let closed = false;
  let messageInFlight = false;
  const dispose = memoize(() => {
    closed = true;
    return conversation.close();
  });

  async function readState(context: Context) {
    return conversation.commit(async (tx) => {
      const { questions, draft } = await tx.doc(
        SpatialPlanningDoc,
        conversation.id,
      );
      const live = await tx.doc(LiveDoc, conversation.id);
      return spatialPlanningSnapshotSchema.parse({
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
    const content = [
      { type: "text" as const, text: input.text },
      ...input.images.map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mime_type,
      })),
    ];
    if (closed) throw new AppError("not_found");

    const [submitError, submission] = await attemptAsync(() =>
      submit({ type: "input", content, whenBusy: "reject" }, context),
    );
    if (submitError instanceof ConversationBusy)
      throw new AppError("workflow_busy");
    if (submission === null) throw submitError;

    const completion = submission.wait(BACKGROUND_CONTEXT).then((settled) => {
      if (settled.status !== "done" || settled.type !== "input")
        throw new AppError("agent_execution_failed");
      return readState(BACKGROUND_CONTEXT);
    });
    const drained = Promise.allSettled([completion]);
    const [error, snapshot] = await attemptAsync(() =>
      awaitWithContext(completion, context),
    );
    if (signal.aborted)
      await conversation.abort(BACKGROUND_CONTEXT).finally(() => drained);

    if (snapshot === null) throw error;
    signal.throwIfAborted();
    return snapshot;
  }

  async function message({
    input,
    signal,
    receive,
  }: {
    input: PlanningMessage;
    signal: AbortSignal;
    receive?: ReceiveProgress | undefined;
  }) {
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
          signal,
          stateDoc: SpatialPlanningDoc,
          onProgress: receive
            ? async (progress, state) => {
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
    message: (options: Parameters<typeof message>[0]) =>
      conversation.withTraceContext(() => message(options)),
    close: (signal: AbortSignal) =>
      conversation.withTraceContext(() => close(signal)),
    dispose,
  };
}
