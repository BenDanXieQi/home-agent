import type { ImageContent, TextContent, Models } from "@earendil-works/pi-ai";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { withGenAiContext } from "@home-agent/observability";
import {
  promptGenerationAttributes,
  type createPromptResolver,
} from "../prompts";
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
  receive?: (kind: "reply" | "reasoning", delta: string) => void;
};

export type MediaPrompt = {
  modelId: string;
  systemPrompt: string;
  messages: { role: "user"; content: MediaAnalysisInput["content"] }[];
  signal: AbortSignal;
  options: {
    maxTokens: number;
    temperature: number;
    topP: number;
    timeoutMs: number;
  };
  payload: unknown;
};

export function createMediaAnalyzer({
  model,
  modelCollection,
  prompts,
}: {
  model: Parameters<Models["completeSimple"]>[0];
  modelCollection: Models;
  prompts: ReturnType<typeof createPromptResolver>;
}) {
  const buildPayload =
    model.api === "google-generative-ai"
      ? buildGeminiPayload
      : model.api === "openai-completions"
        ? model.provider.startsWith("xiaomi")
          ? buildMimoPayload
          : model.provider.startsWith("qwen")
            ? buildQwenPayload
            : undefined
        : undefined;
  if (!buildPayload)
    throw new Error("Configured model API does not support media analysis");

  return {
    analyze: async ({ content, signal, receive }: MediaAnalysisInput) => {
      const prompt = await prompts.resolve({
        name: "media-analysis-agent",
        context: withAbortSignal(signal, BACKGROUND_CONTEXT),
      });
      const messages = [{ role: "user" as const, content }];
      const options = {
        maxTokens: 4096,
        temperature: 0.1,
        topP: 0.95,
        timeoutMs: 120_000,
      };
      const response = await withGenAiContext(
        promptGenerationAttributes(prompt.binding),
        async () => {
          const stream = modelCollection.streamSimple(
            model,
            {
              systemPrompt: prompt.systemPrompt,
              messages: [
                {
                  role: "user",
                  content: content.filter((block) => block.type !== "media"),
                  timestamp: Date.now(),
                },
              ],
            },
            {
              ...options,
              signal,
              sessionId: crypto.randomUUID(),
              maxRetries: 0,
              ...(prompt.config.thinkingLevel === "off"
                ? {}
                : { reasoning: prompt.config.thinkingLevel }),
              onPayload: (payload) =>
                buildPayload({
                  modelId: model.id,
                  systemPrompt: prompt.systemPrompt,
                  messages,
                  signal,
                  options,
                  payload,
                }),
            },
          );
          for await (const event of stream) {
            if (event.type === "text_delta") receive?.("reply", event.delta);
            if (event.type === "thinking_delta")
              receive?.("reasoning", event.delta);
          }
          return stream.result();
        },
      );
      signal.throwIfAborted();
      if (response.stopReason !== "stop")
        throw new Error(response.errorMessage ?? "Incomplete media analysis");
      return readFinalAnswer(response);
    },
  };
}
