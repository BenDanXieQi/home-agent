import type { ImageContent, Models } from "@earendil-works/pi-ai";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { withGenAiContext } from "@home-agent/observability";
import {
  promptGenerationAttributes,
  type createPromptResolver,
} from "../prompts";
import { prepareMediaPrompt } from "./prompt";
import { parseMediaAnalysis } from "./session";
import { buildMimoPayload } from "./providers/mimo";
import { buildQwenPayload } from "./providers/qwen";
import { buildGeminiPayload } from "./providers/gemini";
import { extractMediaUsage } from "./providers/usage";

export { perceptionAnalysisSchema } from "./session";

export type MediaAnalysisInput = {
  media:
    | {
        kind: "video";
        data: Uint8Array;
        fps: number;
        hasAudio: boolean;
        hasSpeech: boolean;
      }
    | { kind: "audio"; data: Uint8Array; hasSpeech: boolean }
    | {
        kind: "images";
        frames: ImageContent[];
        durationSeconds: number;
        audio?: Uint8Array;
        hasSpeech: boolean;
      };
  context?: {
    currentTime?: string;
    roomName?: string;
    homeProfile?: string;
    cameraPrompt?: string;
    pendingSpeech?: { speaker: string; content: string }[];
    rules?: { id: string; name: string; query: string }[];
  };
  identity?: {
    candidates?: {
      trackId: number;
      bbox?: [number, number, number, number];
      faceVisible?: boolean;
      image?: ImageContent;
    }[];
    roster?: {
      kind: "member" | "stranger";
      trackId: number;
      label: string;
      bbox?: [number, number, number, number];
      suppressAsPrior?: boolean;
    }[];
    gallery?: {
      personId: string;
      label: string;
      role?: string;
      body: ImageContent;
      face?: ImageContent;
    }[];
    matchDisabled?: boolean;
    distinguish?: boolean;
    confidenceCutoff?: number;
  };
  pets?: { name: string; species: string; image?: ImageContent }[];
  panorama?: ImageContent;
  signal: AbortSignal;
};

type MediaGenerationOptions = {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
  mediaResolution?: "default" | "high";
  reasoning?: NonNullable<Parameters<Models["completeSimple"]>[2]>["reasoning"];
};

export type MediaPrompt = {
  modelId: string;
  systemPrompt: string;
  messages: ReturnType<ReturnType<typeof prepareMediaPrompt>["buildMessages"]>;
  signal: AbortSignal;
  options: Required<Omit<MediaGenerationOptions, "reasoning">>;
  payload: unknown;
};

const payloadBuilders = {
  mimo: buildMimoPayload,
  qwen: buildQwenPayload,
  gemini: buildGeminiPayload,
};

export function createMediaPerception({
  provider,
  model,
  modelCollection,
  prompts,
  options,
}: {
  provider: keyof typeof payloadBuilders;
  model: Parameters<Models["completeSimple"]>[0];
  modelCollection: Models;
  prompts: ReturnType<typeof createPromptResolver>;
  options?: MediaGenerationOptions;
}) {
  const generation = {
    maxTokens: 512,
    temperature: 0.1,
    topP: 0.95,
    timeoutMs: 30_000,
    mediaResolution: "default" as const,
    ...options,
  };

  async function analyze(input: MediaAnalysisInput) {
    const { signal } = input;
    const prepared = prepareMediaPrompt(input);
    const prompt = await prompts.resolve({
      name: "perception",
      context: withAbortSignal(signal, BACKGROUND_CONTEXT),
      sectionKeys: prepared.sectionKeys,
      systemVariables: prepared.systemVariables,
    });
    const systemPrompt = prepared.buildSystemPrompt(prompt.binding);
    const messages = prepared.buildMessages(prompt.binding);
    let usage = {
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      audio_tokens: 0,
      video_tokens: 0,
    };

    const response = await withGenAiContext(
      promptGenerationAttributes(prompt.binding),
      () =>
        modelCollection.completeSimple(
          model,
          {
            systemPrompt,
            messages: messages.map((message) => ({
              role: "user",
              content: message.content.filter(
                (block) => block.type !== "media",
              ),
              timestamp: Date.now(),
            })),
          },
          {
            signal,
            maxRetries: 0,
            timeoutMs: generation.timeoutMs,
            ...(generation.reasoning
              ? { reasoning: generation.reasoning }
              : {}),
            onPayload: (payload) =>
              payloadBuilders[provider]({
                modelId: model.id,
                systemPrompt,
                messages,
                signal,
                options: generation,
                payload,
              }),
            onProviderStreamEvent: (event) => {
              const current = extractMediaUsage(provider, event);
              if (current) usage = current;
            },
          },
        ),
    );
    signal.throwIfAborted();
    if (response.stopReason !== "stop")
      throw new Error(response.errorMessage ?? "Incomplete media analysis");

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    return { ...parseMediaAnalysis(text, input), usage };
  }

  return { analyze };
}
