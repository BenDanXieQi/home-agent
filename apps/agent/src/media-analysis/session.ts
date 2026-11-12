import { z } from "zod";
import { agentContextDataSchemas } from "@home-agent/api/agent-context";
import {
  AssistantEntry,
  ToolResultEntry,
  ResetEntry,
  defineEntry,
  defineDoc,
  type ConversationId,
  type ConversationView,
  type Cursor,
} from "@earendil-works/pi-durable";
import { contentText } from "@earendil-works/pi-ai";
import { AppError } from "@home-agent/api/errors";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { createAgentHarness } from "../harness";
import type { initializeModelRuntime } from "../models";
import type { createMediaAnalysisExtension } from "./extension";

function finalReply(entry: ConversationView["entries"][number]) {
  const message = AssistantEntry.is(entry) ? entry.model?.[0] : undefined;
  if (
    message?.role !== "assistant" ||
    !["stop", "length"].includes(message.stopReason)
  )
    return undefined;

  const reply = contentText(message.content, "");
  return reply.trim() ? reply : undefined;
}

export function createMediaAnalysisSession({
  harness,
  model,
  extension,
  onHistory,
}: {
  harness: ReturnType<typeof createAgentHarness>;
  model: NonNullable<
    ReturnType<
      Awaited<ReturnType<typeof initializeModelRuntime>>["findAvailableModel"]
    >
  >;
  extension: ReturnType<typeof createMediaAnalysisExtension>["extension"];
  onHistory: (page: z.infer<typeof mediaAgentHistoryPageSchema>) => void;
}) {
  const MediaAgentDoc = defineDoc<{ conversationId?: ConversationId }>({
    kind: "home.media-agent",
    version: 1,
    scope: "session",
    initial: () => ({}),
    checkpointWhen: () => true,
  });
  const summaryEntry = defineEntry<
    z.infer<typeof mediaAnalysisRecordingSchema>
  >(mediaAnalysisSummaryKind);
  let pending: ReturnType<typeof harness.createConversation> | undefined;
  let watch:
    | Awaited<ReturnType<Awaited<NonNullable<typeof pending>>["watch"]>>
    | undefined;
  let latestAssistantId: ConversationView["entries"][number]["id"] | undefined;
  let received = false;
  let receiving: Promise<void> | undefined;

  async function readHistory(
    conversation: Pick<
      Awaited<ReturnType<typeof harness.createConversation>>,
      "id" | "commit"
    >,
    before?: string,
    signal?: AbortSignal,
  ) {
    const context = signal
      ? withAbortSignal(signal, BACKGROUND_CONTEXT)
      : BACKGROUND_CONTEXT;
    let initialCursor: Cursor | undefined;
    if (before !== undefined) {
      try {
        initialCursor = z
          .record(z.string(), z.json())
          .parse(JSON.parse(before));
      } catch (cause) {
        throw new AppError("invalid_request", { cause });
      }
    }

    const { entries, nextCursor } = await conversation.commit(async (tx) => {
      const collected: ConversationView["entries"][number][] = [];
      const query = {
        conversationId: conversation.id,
        order: "descending" as const,
      };
      let cursor = initialCursor;
      let conclusions = 0;
      do {
        const page = await tx.scanEntries(query, 256, cursor);
        const boundary = page.items.findIndex(
          (entry) => finalReply(entry) !== undefined && ++conclusions > 30,
        );
        if (boundary !== -1) {
          collected.push(...page.items.slice(0, boundary));
          // Leave the previous conclusion for the next page; its following
          // entries contain the complete first round on this page.
          const next = boundary
            ? (await tx.scanEntries(query, boundary, cursor)).next
            : cursor;
          return {
            entries: collected.toReversed(),
            nextCursor: next ? JSON.stringify(next) : null,
          };
        }
        collected.push(...page.items);
        cursor = page.next;
      } while (cursor);
      return { entries: collected.toReversed(), nextCursor: null };
    }, context);

    const history: z.infer<typeof mediaAgentHistoryEntrySchema>[] = [];
    let recordings: z.infer<typeof mediaAnalysisRecordingSchema>[] = [];
    let reasoning: string[] = [];
    let startedAt: number | undefined;
    for (const entry of entries) {
      if (ResetEntry.is(entry)) {
        recordings = [];
        reasoning = [];
        startedAt = undefined;
        continue;
      }
      if (summaryEntry.is(entry)) {
        recordings.push(entry.data);
        continue;
      }
      if (ToolResultEntry.is(entry)) {
        const message = entry.model?.[0];
        if (
          message?.role === "toolResult" &&
          message.toolName === "read_camera_media" &&
          !message.isError
        )
          recordings.push(mediaAnalysisRecordingSchema.parse(message.details));
        continue;
      }
      if (!AssistantEntry.is(entry)) continue;
      const message = entry.model?.[0];
      if (message?.role !== "assistant") continue;
      startedAt ??= message.timestamp;
      if (["error", "aborted"].includes(message.stopReason)) {
        const taskId = entry.byTaskId;
        if (taskId) {
          const task = await conversation.commit(
            (tx) => tx.task(taskId),
            context,
          );
          if (!task) throw new Error("Media agent request task is unavailable");
          if (
            task.state.status !== "terminal" ||
            task.state.outcome.status === "completed"
          )
            continue;
        }

        recordings = [];
        reasoning = [];
        startedAt = undefined;
        continue;
      }

      reasoning.push(
        ...message.content
          .filter((block) => block.type === "thinking")
          .map((block) => block.thinking),
      );
      if (!["stop", "length"].includes(message.stopReason)) continue;
      const reply = finalReply(entry);
      if (reply !== undefined) {
        const taskId = entry.byTaskId;
        const task =
          taskId &&
          (await conversation.commit((tx) => tx.task(taskId), context));
        if (task?.endedAt === undefined)
          throw new Error("Media agent conclusion has no completion time");

        history.push({
          id: String(entry.id),
          startedAt,
          completedAt: task.endedAt,
          reasoning: reasoning.join("\n\n"),
          reply,
          recordings,
        });
      }
      recordings = [];
      reasoning = [];
      startedAt = undefined;
    }
    return { entries: history.toReversed(), nextCursor };
  }

  async function receive(
    view: ConversationView,
    conversation: Parameters<typeof readHistory>[0],
  ) {
    const latest = view.entries
      .filter((entry) => AssistantEntry.is(entry))
      .at(-1)?.id;
    if (received && latest === latestAssistantId) return;

    const page = await readHistory(conversation);
    latestAssistantId = latest;
    received = true;
    onHistory(page);
  }

  async function open(signal: AbortSignal) {
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const id = await harness.commit(async (tx) => {
      return (await tx.doc(MediaAgentDoc)).conversationId;
    }, context);
    if (id !== undefined) {
      const conversation = await harness.conversation(id, context);
      if (!conversation)
        throw new Error("The media Agent session is unavailable");
      return harness.prepareManagedConversation({
        conversation,
        agentName: "媒体主Agent",
        context,
      });
    }

    return harness.createConversation(
      {
        agentName: "媒体主Agent",
        ownership: { kind: "ownerless" },
        prompt: { name: "media-agent" },
        agent: {
          model: { provider: model.provider, modelId: model.id },
          extensions: [extension],
        },
        init: async (tx, conversationId) => {
          (await tx.doc(MediaAgentDoc)).conversationId = conversationId;
        },
      },
      context,
    );
  }

  function current(signal: AbortSignal) {
    if (pending) return pending;

    const opening = open(signal).then(async (conversation) => {
      try {
        await conversation.configure(
          { model: { provider: model.provider, modelId: model.id } },
          withAbortSignal(signal, BACKGROUND_CONTEXT),
        );
        watch = await conversation.watch(BACKGROUND_CONTEXT);
        await receive(watch.value, conversation);
        watch.start(async (value) => {
          receiving = receive(value, conversation);
          try {
            await receiving;
          } finally {
            receiving = undefined;
          }
        });
        return conversation;
      } catch (error) {
        await conversation.close();
        throw error;
      }
    });
    pending = opening;
    opening.catch(() => {
      if (pending === opening) pending = undefined;
    });
    return opening;
  }

  async function close() {
    if (!pending) return;

    const [settled] = await Promise.allSettled([pending]);
    try {
      await watch?.stop();
      await receiving;
    } finally {
      if (settled.status === "fulfilled") await settled.value.close();
    }
  }

  return {
    current,
    close,
    async history(before: string | undefined, signal: AbortSignal) {
      return readHistory(await current(signal), before, signal);
    },
  };
}

export const mediaAnalysisEntrySchema =
  agentContextDataSchemas.observations.shape.media_ranges.element
    .omit({ settledAt: true, ready: true })
    .extend({
      queuedAt: z.number(),
      status: z.enum([
        "collecting",
        "queued",
        "preparing",
        "analyzing",
        "saving",
        "completed",
        "failed",
        "expired",
        "skipped",
      ]),
      deviceName: z.string(),
      location: z.string(),
      analysisStartedAt: z.number().nullable(),
      completedAt: z.number().nullable(),
      reply: z.string().max(64 * 1024),
      reasoning: z.string().max(128 * 1024),
      error: z.string().nullable(),
      media: z.array(
        z.object({
          index: z.number().int().nonnegative(),
          kind: z.enum(["video", "audio"]),
          contentType: z.string().min(1),
        }),
      ),
    });

export const mediaAnalysisCompletedSchema = mediaAnalysisEntrySchema.extend({
  status: z.literal("completed"),
  completedAt: z.number(),
  reply: z
    .string()
    .min(1)
    .max(64 * 1024),
});

export const mediaAnalysisRecordingSchema = mediaAnalysisEntrySchema
  .pick({
    id: true,
    source: true,
    startedAt: true,
    endedAt: true,
    kind: true,
    includeAudio: true,
    deviceName: true,
    location: true,
    reply: true,
    reasoning: true,
  })
  .extend({
    analysisStartedAt: z.number(),
    completedAt: z.number(),
    question: z.string().nullable(),
    observationTarget: z
      .object({ id: z.string(), name: z.string() })
      .nullable(),
  });

export const mediaAnalysisSummaryKind = "home.media-analysis-summary";

export const mediaAgentHistoryEntrySchema = z.object({
  id: z.string(),
  startedAt: z.number(),
  completedAt: z.number(),
  reasoning: z.string(),
  reply: z.string(),
  recordings: z.array(mediaAnalysisRecordingSchema),
});

export const mediaAgentHistoryPageSchema = z.object({
  entries: z.array(mediaAgentHistoryEntrySchema),
  nextCursor: z.string().nullable(),
});

export const mediaAgentHistoryQuerySchema = z.object({
  before: z.string().optional(),
});

export const mediaAnalysisSnapshotSchema = z.object({
  enabled: z.boolean(),
  history: mediaAgentHistoryPageSchema,
  observationTargets: z.array(
    mediaAnalysisRecordingSchema.shape.observationTarget.unwrap(),
  ),
  entries: z.array(
    mediaAnalysisEntrySchema
      .omit({ reply: true, reasoning: true, media: true })
      .extend({
        summary: z.string(),
        observationTarget: mediaAnalysisRecordingSchema.shape.observationTarget,
      }),
  ),
});

export const mediaAnalysisInputSchema = mediaAnalysisEntrySchema
  .pick({
    source: true,
    startedAt: true,
    endedAt: true,
    kind: true,
    includeAudio: true,
  })
  .refine(
    (value) => value.startedAt < value.endedAt,
    "Media range must have positive duration",
  );
