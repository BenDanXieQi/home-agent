import type {
  ImageContent,
  TextContent,
  Provider,
} from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  LiveDoc,
  type ConversationHandle,
} from "@earendil-works/pi-durable";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { z } from "zod";
import type { createAgentHarness } from "../harness";
import { withConversationProgress } from "../conversation/progress";
import type { conversationProgressSchema } from "../conversation/contracts";
import { readFinalAnswer } from "../utils/final-answer";
import { buildMimoPayload } from "./providers/mimo";
import { buildQwenPayload } from "./providers/qwen";
import { buildGeminiPayload } from "./providers/gemini";

const mediaTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

export function formatMediaTime(at: number) {
  return mediaTimeFormatter.format(at);
}

export type MediaAnalysisInput = {
  content: (
    | TextContent
    | ImageContent
    | {
        type: "media";
        media:
          | { kind: "video"; data: Uint8Array; fps: number }
          | { kind: "audio"; data: Uint8Array };
      }
  )[];
  signal: AbortSignal;
};

export type MediaPrompt = {
  media: Extract<MediaAnalysisInput["content"][number], { type: "media" }>[];
  payload: unknown;
};

const conversationMedia = new Map<
  ConversationHandle["id"],
  { media: MediaPrompt["media"]; requests: Map<AbortSignal, () => void> }
>();
const requestMedia = new WeakMap<AbortSignal, MediaPrompt["media"]>();

export function associateConversationMedia(
  conversationId: ConversationHandle["id"],
  content: MediaAnalysisInput["content"],
) {
  const association = {
    media: content.filter((block) => block.type === "media"),
    requests: new Map<AbortSignal, () => void>(),
  };
  conversationMedia.set(conversationId, association);

  return () => {
    conversationMedia.delete(conversationId);
    for (const release of association.requests.values()) release();
  };
}

export function bindMediaRequest(
  conversationId: ConversationHandle["id"],
  signal: AbortSignal | undefined,
) {
  const association = conversationMedia.get(conversationId);
  if (!association || !signal) return;
  signal.throwIfAborted();

  const release = () => {
    requestMedia.delete(signal);
    association.requests.delete(signal);
    signal.removeEventListener("abort", release);
  };
  requestMedia.set(signal, association.media);
  association.requests.set(signal, release);
  signal.addEventListener("abort", release, { once: true });
}

export function releaseMediaRequest(signal: AbortSignal | undefined) {
  if (!signal) return;
  requestMedia.delete(signal);
  for (const association of conversationMedia.values())
    association.requests.get(signal)?.();
}

export async function analyzeMediaConversation({
  harness,
  conversation,
  content,
  signal,
  requestId,
  onProgress,
}: MediaAnalysisInput & {
  harness: ReturnType<typeof createAgentHarness>;
  conversation: Awaited<
    ReturnType<
      ReturnType<typeof createAgentHarness>["prepareManagedConversation"]
    >
  >;
  requestId: string;
  onProgress?:
    | ((
        progress: z.infer<typeof conversationProgressSchema>,
        reasoning: string,
      ) => Promise<void>)
    | undefined;
}) {
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const release = associateConversationMedia(conversation.id, content);
  let reasoning = "";
  try {
    return await withConversationProgress(
      harness,
      {
        conversation,
        signal,
        onProgress: onProgress
          ? async (progress) => {
              const currentReasoning = await conversation.commit(async (tx) => {
                const live = await tx.doc(LiveDoc, conversation.id);
                if (!live.generation?.message) return null;
                return live.generation.message.content
                  .filter((block) => block.type === "thinking")
                  .map((block) => block.thinking)
                  .join("");
              }, context);
              if (currentReasoning !== null) reasoning = currentReasoning;
              await onProgress(progress, reasoning);
            }
          : undefined,
      },
      async ({ signal: progressSignal, submit }) => {
        const requestContext = withAbortSignal(progressSignal, context);
        const submission = await submit(
          {
            type: "input",
            content: content.filter((block) => block.type !== "media"),
            requestId,
          },
          requestContext,
        );
        const settled = await submission.wait(requestContext);
        if (settled.status !== "done" || settled.type !== "input")
          throw new Error(
            settled.status === "unanswered" &&
              typeof settled.detail === "string"
              ? settled.detail
              : "Media analysis did not complete",
          );

        return conversation.commit(async (tx) => {
          const entry = await tx.entry(AssistantEntry, settled.answer);
          const message = entry?.model?.[0];
          const reply = readFinalAnswer(
            message?.role === "assistant" ? message : undefined,
          );
          const task = entry?.byTaskId && (await tx.task(entry.byTaskId));
          if (message?.role !== "assistant" || task?.endedAt === undefined)
            throw new Error("Media analysis has no completion time");

          return {
            reply,
            reasoning: message.content
              .filter((block) => block.type === "thinking")
              .map((block) => block.thinking)
              .join(""),
            completedAt: task.endedAt,
          };
        }, requestContext);
      },
    );
  } finally {
    release();
  }
}

export function withMediaProvider(provider: Provider) {
  return {
    ...provider,
    streamSimple: (model, transcript, options) => {
      const media = options?.signal && requestMedia.get(options.signal);
      if (!media?.length)
        return provider.streamSimple(model, transcript, options);

      return provider.streamSimple(model, transcript, {
        ...options,
        onPayload: async (payload, requestModel) => {
          const buildPayload =
            model.api === "google-generative-ai"
              ? buildGeminiPayload
              : model.api === "openai-completions"
                ? model.provider.startsWith("xiaomi")
                  ? buildMimoPayload
                  : model.provider.startsWith("qwen") ||
                      model.provider === "llamacpp"
                    ? buildQwenPayload
                    : undefined
                : undefined;
          if (!buildPayload)
            throw new Error(
              "Configured model API does not support media analysis",
            );

          const adapted = buildPayload({ payload, media });
          const replacement = await options?.onPayload?.(adapted, requestModel);
          return replacement === undefined ? adapted : replacement;
        },
      });
    },
  } satisfies Provider;
}
