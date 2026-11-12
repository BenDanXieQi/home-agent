import { z } from "zod";
import {
  withAbortSignal,
  BACKGROUND_CONTEXT,
} from "@earendil-works/chord/context";
import {
  GenerationTask,
  defineExtension,
  defineTool,
  hook,
  type ModelRef,
} from "@earendil-works/pi-durable";
import type { createAgentHarness } from "../harness";
import type { conversationProgressSchema } from "../conversation/contracts";
import {
  analyzeMediaConversation,
  bindMediaRequest,
  releaseMediaRequest,
  type MediaAnalysisInput,
} from "./analysis";
import {
  mediaAnalysisEntrySchema,
  mediaAnalysisRecordingSchema,
} from "./session";

export const readCameraMediaSchema = mediaAnalysisEntrySchema
  .pick({ source: true, startedAt: true, endedAt: true })
  .extend({ question: z.string().trim().min(1).max(4_096) })
  .refine(
    (value) => value.startedAt < value.endedAt,
    "Media range must have positive duration",
  );

export const emitMediaEventSchema = z
  .strictObject({
    description: z.string().trim().min(1).max(16_384),
    startedAt: z.number().finite(),
    endedAt: z.number().finite(),
    location: z.string().trim().min(1).max(1_024),
    reason: z.string().trim().min(1).max(4_096),
    uncertainty: z.string().trim().min(1).max(4_096),
  })
  .refine(
    (value) => value.startedAt <= value.endedAt,
    "Event end must not precede its start",
  );

export const mediaAnalysisTaskInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("initial"),
    range: mediaAnalysisEntrySchema,
  }),
  z.strictObject({ kind: z.literal("camera"), request: readCameraMediaSchema }),
]);

type Dependencies = {
  harness: ReturnType<typeof createAgentHarness>;
  model: ModelRef;
  readInput: (
    input: z.infer<typeof mediaAnalysisTaskInputSchema>,
    signal: AbortSignal,
  ) => Promise<{
    content: MediaAnalysisInput["content"];
    recording: Omit<
      z.infer<typeof mediaAnalysisRecordingSchema>,
      "reply" | "reasoning" | "analysisStartedAt" | "completedAt"
    >;
  }>;
  onProgress?: (
    input: z.infer<typeof mediaAnalysisTaskInputSchema>,
    progress: z.infer<typeof conversationProgressSchema>,
    reasoning: string,
  ) => Promise<void>;
  emitEvent: (
    event: z.infer<typeof emitMediaEventSchema>,
    requestId: string,
    signal: AbortSignal,
  ) => Promise<void>;
};

export function createMediaAnalysisExtension() {
  let dependencies: Dependencies | undefined;

  function currentDependencies() {
    if (!dependencies) throw new Error("Media analysis is not configured");
    return dependencies;
  }

  async function analyze(
    input: z.infer<typeof mediaAnalysisTaskInputSchema>,
    signal: AbortSignal,
  ) {
    const { harness, model, readInput, onProgress } = currentDependencies();
    const analysisStartedAt = Date.now();
    const execution = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const { content, recording } = await readInput(input, signal);
    if (input.kind === "camera")
      content.push({
        type: "text",
        text: `本次核实问题：${input.request.question}`,
      });

    await using conversation = await harness.createConversation(
      {
        agentName: "媒体分析子Agent",
        ownership: { kind: "ownerless" },
        prompt: { name: "media-analysis-agent" },
        agent: { model, extensions: [extension], tools: [] },
      },
      execution,
    );
    const result = await analyzeMediaConversation({
      harness,
      conversation,
      content,
      signal,
      requestId: `media-analysis:${conversation.id}`,
      onProgress: onProgress
        ? (progress, reasoning) => onProgress(input, progress, reasoning)
        : undefined,
    });
    return mediaAnalysisRecordingSchema.parse({
      ...recording,
      ...result,
      analysisStartedAt:
        input.kind === "initial"
          ? input.range.analysisStartedAt
          : analysisStartedAt,
    });
  }

  const extension = defineExtension({
    name: "media-analysis",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (_request, api, context) => {
          bindMediaRequest(api.conversationId, context.abortSignal);
          return undefined;
        },
        afterResponse: (_message, _api, context) => {
          releaseMediaRequest(context.abortSignal);
        },
      }),
    ],
    tools: [
      defineTool({
        name: "read_camera_media",
        description: "读取本地摄像头录像，由独立媒体分析回答核实问题",
        parameters: z.toJSONSchema(readCameraMediaSchema),
        executionMode: "sequential",
        execute: async (args, _api, context) => {
          const request = readCameraMediaSchema.parse(args);
          const signal = AbortSignal.any([
            ...(context.abortSignal ? [context.abortSignal] : []),
            AbortSignal.timeout(120_000),
          ]);
          const result = await analyze({ kind: "camera", request }, signal);

          return {
            output: [{ type: "text" as const, text: result.reply }],
            details: result,
          };
        },
      }),
      defineTool({
        name: "emit_event",
        description: "把需要继续处理的家庭事件交接整体主 Agent",
        parameters: z.toJSONSchema(emitMediaEventSchema),
        executionMode: "sequential",
        execute: async (args, api, context) => {
          const { emitEvent } = currentDependencies();
          const event = emitMediaEventSchema.parse(args);
          const signal = context.abortSignal;
          if (!signal) throw new Error("Missing event execution signal");
          await emitEvent(event, `media-event:${api.taskId}`, signal);
          return {
            output: [
              { type: "text" as const, text: "整体主 Agent 已接纳事件。" },
            ],
          };
        },
      }),
    ],
  });

  return {
    extension,
    analyze,
    configure(value: Dependencies) {
      dependencies = value;
    },
  };
}
