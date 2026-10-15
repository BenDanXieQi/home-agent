import {
  createAssistantMessageEventStream,
  lazyStream,
  type Model,
  type TranscriptContext,
  type Provider,
  type Api,
  type ApiStreamOptions,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { recordFailure, SpanKind, withSpan } from "./spans";
import { genAiMessages, genAiToolDefinitions } from "./messages";
import { telemetryStatus } from "./telemetry";
import { recordEvaluationModel } from "./evaluation";
import { z } from "zod";

const tokenCount = z.number().int().nonnegative();
const usageSchema = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
});
const responseUsageEventSchema = z.object({
  type: z.enum(["response.done", "response.completed", "response.incomplete"]),
  response: z.object({
    usage: z.object({ input_tokens: tokenCount, output_tokens: tokenCount }),
  }),
});
const completionUsageEventSchema = z.union([
  z.object({ usage: usageSchema }),
  z.object({
    choices: z.tuple([z.object({ usage: usageSchema })]).rest(z.unknown()),
  }),
]);
const anthropicUsageSchema = z
  .object({
    input_tokens: tokenCount.nullish(),
    output_tokens: tokenCount.nullish(),
  })
  .refine((usage) => Object.values(usage).some((count) => count != null));
const anthropicUsageEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_start"),
    message: z.object({ usage: anthropicUsageSchema }),
  }),
  z.object({ type: z.literal("message_delta"), usage: anthropicUsageSchema }),
]);
const googleUsageEventSchema = z.object({
  usageMetadata: z
    .object({
      promptTokenCount: tokenCount.nullish(),
      candidatesTokenCount: tokenCount.nullish(),
      thoughtsTokenCount: tokenCount.nullish(),
      cachedContentTokenCount: tokenCount.nullish(),
    })
    .refine((usage) => Object.values(usage).some((count) => count != null)),
});
const bedrockUsageEventSchema = z.object({
  metadata: z.object({
    usage: z.object({ inputTokens: tokenCount, outputTokens: tokenCount }),
  }),
});
const piUsageEventSchema = z.object({
  type: z.enum(["done", "error"]),
  usage: z.object({ input: tokenCount, output: tokenCount }),
});

function reportsUsage(api: Api, event: unknown) {
  switch (api) {
    case "openai-completions":
    case "mistral-conversations":
      return completionUsageEventSchema.safeParse(event).success;
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return responseUsageEventSchema.safeParse(event).success;
    case "anthropic-messages":
      return anthropicUsageEventSchema.safeParse(event).success;
    case "google-generative-ai":
    case "google-vertex":
      return googleUsageEventSchema.safeParse(event).success;
    case "bedrock-converse-stream":
      return bedrockUsageEventSchema.safeParse(event).success;
    case "pi-messages":
      return piUsageEventSchema.safeParse(event).success;
    default:
      return false;
  }
}
const reasoningEffort = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
]);
const modelParametersSchema = z.object({
  max_tokens: z.number().int().nonnegative().optional().catch(undefined),
  max_completion_tokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .catch(undefined),
  max_output_tokens: tokenCount.optional().catch(undefined),
  temperature: z.number().optional().catch(undefined),
  top_p: z.number().optional().catch(undefined),
  top_k: z.number().optional().catch(undefined),
  min_p: z.number().optional().catch(undefined),
  repetition_penalty: z.number().optional().catch(undefined),
  frequency_penalty: z.number().optional().catch(undefined),
  presence_penalty: z.number().optional().catch(undefined),
  seed: z.number().int().optional().catch(undefined),
  reasoning_effort: reasoningEffort.optional().catch(undefined),
  thinking: z
    .union([
      reasoningEffort,
      z.object({
        type: z.enum(["enabled", "disabled", "adaptive"]),
        budget_tokens: z.number().int().nonnegative().optional(),
        clear_thinking: z.boolean().optional(),
      }),
    ])
    .optional()
    .catch(undefined),
  reasoning: z
    .object({
      effort: reasoningEffort.optional(),
      summary: z.enum(["auto", "concise", "detailed"]).optional(),
      enabled: z.boolean().optional(),
      exclude: z.boolean().optional(),
      max_tokens: z.number().int().nonnegative().optional(),
    })
    .optional()
    .catch(undefined),
  text: z
    .object({ verbosity: z.enum(["low", "medium", "high"]).optional() })
    .optional()
    .catch(undefined),
  enable_thinking: z.boolean().optional().catch(undefined),
  service_tier: z
    .enum(["auto", "default", "flex", "priority"])
    .optional()
    .catch(undefined),
  thinking_token_budget: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .catch(undefined),
  chat_template_kwargs: z
    .object({
      enable_thinking: z.boolean().optional(),
      preserve_thinking: z.boolean().optional(),
    })
    .optional()
    .catch(undefined),
});
export function observeProvider(provider: Provider) {
  return {
    ...provider,
    stream: <TApi extends Api>(
      model: Model<TApi>,
      context: TranscriptContext,
      options?: ApiStreamOptions<TApi>,
    ) =>
      observeModelStream(model, context, options ?? {}, (observers) =>
        provider.stream(model, context, Object.assign({}, options, observers)),
      ),
    streamSimple: (
      model: Model<Api>,
      context: TranscriptContext,
      options: SimpleStreamOptions = {},
    ) =>
      observeModelStream(model, context, options, (observers) =>
        provider.streamSimple(model, context, {
          ...options,
          ...observers,
        }),
      ),
  } satisfies Provider;
}

function observeModelStream(
  model: Model<Api>,
  context: TranscriptContext,
  options: StreamOptions,
  start: (
    observers: Required<
      Pick<StreamOptions, "onPayload" | "onProviderStreamEvent">
    >,
  ) => ReturnType<Provider["stream"]>,
) {
  const output = createAssistantMessageEventStream();
  withSpan(
    `chat ${model.id}`,
    {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": model.provider,
      "gen_ai.request.model": model.id,
      "gen_ai.request.stream": true,
    },
    async (span) => {
      recordEvaluationModel(context, span);
      if (span.isRecording() && telemetryStatus().includeContent) {
        span.setAttributes({
          "gen_ai.input.messages": JSON.stringify(
            genAiMessages(context.messages),
          ),
          "gen_ai.tool.definitions": JSON.stringify(
            genAiToolDefinitions(context.messages),
          ),
        });
      }
      try {
        let reportedUsage = false;
        let completionStarted = false;
        let firstChunkReceived = false;
        const startedAt = performance.now();
        const stream = start({
          onPayload: async (payload, requestModel) => {
            const replacement = await options.onPayload?.(
              payload,
              requestModel,
            );
            if (span.isRecording()) {
              const parameters = modelParametersSchema.safeParse(
                replacement === undefined ? payload : replacement,
              );
              if (parameters.success) {
                const {
                  max_tokens,
                  max_completion_tokens,
                  max_output_tokens,
                  reasoning_effort,
                  ...sampling
                } = parameters.data;
                span.setAttributes({
                  "gen_ai.request.max_tokens":
                    max_completion_tokens ?? max_output_tokens ?? max_tokens,
                  "gen_ai.request.reasoning.level":
                    reasoning_effort ??
                    sampling.reasoning?.effort ??
                    (typeof sampling.thinking === "string"
                      ? sampling.thinking
                      : undefined),
                  ...Object.fromEntries(
                    Object.entries(sampling)
                      .filter(([, value]) => value !== undefined)
                      .map(([key, value]) => [
                        [
                          "temperature",
                          "top_p",
                          "top_k",
                          "frequency_penalty",
                          "presence_penalty",
                          "seed",
                        ].includes(key)
                          ? `gen_ai.request.${key}`
                          : `home_agent.request.${key}`,
                        typeof value === "object"
                          ? JSON.stringify(value)
                          : value,
                      ]),
                  ),
                });
              }
            }
            return replacement;
          },
          onProviderStreamEvent: async (data, requestModel) => {
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              span.setAttribute(
                "gen_ai.response.time_to_first_chunk",
                (performance.now() - startedAt) / 1_000,
              );
            }
            const chunkReportedUsage = reportsUsage(model.api, data);
            await options.onProviderStreamEvent?.(data, requestModel);
            if (chunkReportedUsage) reportedUsage = true;
          },
        });
        for await (const event of stream) {
          if (
            !completionStarted &&
            (event.type === "text_delta" ||
              event.type === "thinking_delta" ||
              event.type === "toolcall_delta") &&
            event.delta.length > 0
          ) {
            completionStarted = true;
            span.setAttribute(
              "langfuse.observation.completion_start_time",
              new Date().toISOString(),
            );
          }
          if (event.type === "done" || event.type === "error") {
            const response =
              event.type === "done" ? event.message : event.error;
            if (reportedUsage && span.isRecording()) {
              const usage = response.usage;
              const reasoningTokens =
                usage.reasoning !== undefined && usage.reasoning <= usage.output
                  ? usage.reasoning
                  : 0;
              span.setAttributes({
                "gen_ai.usage.input_tokens":
                  usage.input + usage.cacheRead + usage.cacheWrite,
                "gen_ai.usage.output_tokens": usage.output,
                ...(usage.cacheRead > 0
                  ? { "gen_ai.usage.cache_read.input_tokens": usage.cacheRead }
                  : {}),
                ...(usage.cacheWrite > 0
                  ? {
                      "gen_ai.usage.cache_write.input_tokens": usage.cacheWrite,
                    }
                  : {}),
                ...(reasoningTokens > 0
                  ? { "gen_ai.usage.reasoning.output_tokens": reasoningTokens }
                  : {}),
              });
            }
            span.setAttribute("gen_ai.response.finish_reasons", [
              event.type === "error"
                ? "error"
                : (response.rawStopReason ??
                  (response.stopReason === "toolUse"
                    ? "tool_call"
                    : response.stopReason)),
            ]);
            if (response.responseModel) {
              span.setAttribute(
                "gen_ai.response.model",
                response.responseModel,
              );
            }
            if (response.responseId)
              span.setAttribute("gen_ai.response.id", response.responseId);
            if (
              span.isRecording() &&
              telemetryStatus().includeContent &&
              (event.type === "done" || response.content.length > 0)
            )
              span.setAttribute(
                "gen_ai.output.messages",
                JSON.stringify(genAiMessages([response])),
              );
            if (event.type === "error")
              recordFailure(
                span,
                response.stopReason === "aborted"
                  ? options.signal?.reason instanceof Error
                    ? options.signal.reason
                    : new DOMException("Model request aborted", "AbortError")
                  : new Error(response.errorMessage ?? "Model request failed"),
              );
            else if (response.stopReason === "length")
              recordFailure(
                span,
                new Error("Model output token limit reached"),
              );
          }
          output.push(event);
        }
      } catch (error) {
        span.setAttribute("gen_ai.response.finish_reasons", ["error"]);
        recordFailure(span, error);
        const failed = lazyStream(model, async () => {
          throw error;
        });
        for await (const event of failed) output.push(event);
      }
    },
    { kind: SpanKind.CLIENT },
  ).catch(async (error: unknown) => {
    const failed = lazyStream(model, async () => {
      throw error;
    });
    for await (const event of failed) output.push(event);
  });
  return output;
}
