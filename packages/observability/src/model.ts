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
import { genAiMessages } from "./messages";
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
function lenient<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}
const modelParametersSchema = z.object({
  max_tokens: lenient(tokenCount),
  max_completion_tokens: lenient(tokenCount),
  max_output_tokens: lenient(tokenCount),
  temperature: lenient(z.number()),
  top_p: lenient(z.number()),
  top_k: lenient(z.number()),
  min_p: lenient(z.number()),
  repetition_penalty: lenient(z.number()),
  frequency_penalty: lenient(z.number()),
  presence_penalty: lenient(z.number()),
  seed: lenient(z.number().int()),
  reasoning_effort: lenient(reasoningEffort),
  thinking: lenient(
    z.union([
      reasoningEffort,
      z.object({
        type: z.enum(["enabled", "disabled", "adaptive"]),
        budget_tokens: tokenCount.optional(),
        clear_thinking: z.boolean().optional(),
      }),
    ]),
  ),
  reasoning: lenient(
    z.object({
      effort: reasoningEffort.optional(),
      summary: z.enum(["auto", "concise", "detailed"]).optional(),
      enabled: z.boolean().optional(),
      exclude: z.boolean().optional(),
      max_tokens: tokenCount.optional(),
    }),
  ),
  text: lenient(
    z.object({ verbosity: z.enum(["low", "medium", "high"]).optional() }),
  ),
  enable_thinking: lenient(z.boolean()),
  service_tier: lenient(z.enum(["auto", "default", "flex", "priority"])),
  thinking_token_budget: lenient(tokenCount),
  chat_template_kwargs: lenient(
    z.object({
      enable_thinking: z.boolean().optional(),
      preserve_thinking: z.boolean().optional(),
    }),
  ),
});
const standardRequestParameters = new Set([
  "temperature",
  "top_p",
  "top_k",
  "frequency_penalty",
  "presence_penalty",
  "seed",
]);
export function observeProvider(provider: Provider) {
  return {
    ...provider,
    stream: <TApi extends Api>(
      model: Model<TApi>,
      context: TranscriptContext,
      options?: ApiStreamOptions<TApi>,
    ) =>
      telemetryStatus().enabled
        ? observeModelStream(model, options ?? {}, (observers) =>
            provider.stream(
              model,
              context,
              Object.assign({}, options, observers),
            ),
          )
        : provider.stream(model, context, options),
    streamSimple: (
      model: Model<Api>,
      context: TranscriptContext,
      options: SimpleStreamOptions = {},
    ) =>
      telemetryStatus().enabled
        ? observeModelStream(model, options, (observers) =>
            provider.streamSimple(model, context, {
              ...options,
              ...observers,
            }),
          )
        : provider.streamSimple(model, context, options),
  } satisfies Provider;
}

function observeModelStream(
  model: Model<Api>,
  options: StreamOptions,
  start: (
    observers: Required<
      Pick<StreamOptions, "onPayload" | "onProviderStreamEvent">
    >,
  ) => ReturnType<Provider["stream"]>,
) {
  const output = createAssistantMessageEventStream();
  const fail = async (error: unknown) => {
    const failed = lazyStream(model, async () => {
      throw error;
    });
    for await (const event of failed) output.push(event);
  };
  withSpan(
    `chat ${model.id}`,
    {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": model.provider,
      "gen_ai.request.model": model.id,
      "gen_ai.request.stream": true,
    },
    async (span) => {
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
            const request = replacement === undefined ? payload : replacement;
            if (telemetryStatus().includeContent) {
              try {
                const serialized = JSON.stringify(request);
                if (serialized !== undefined) {
                  const input: unknown = JSON.parse(serialized);
                  recordEvaluationModel(input, span);
                  if (span.isRecording())
                    span.setAttribute("langfuse.observation.input", serialized);
                }
              } catch {
                console.error(
                  "Agent tracing: model input serialization failed",
                );
              }
            }

            if (span.isRecording()) {
              const parameters = modelParametersSchema.safeParse(request);
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
                        standardRequestParameters.has(key)
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
            const chunkReportedUsage =
              !reportedUsage && reportsUsage(model.api, data);
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
            ) {
              const serialized = JSON.stringify(genAiMessages([response]));
              span.setAttributes({
                "gen_ai.output.messages": serialized,
                "langfuse.observation.output": serialized,
              });
            }
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
        await fail(error);
      }
    },
    { kind: SpanKind.CLIENT },
  ).catch(fail);
  return output;
}
