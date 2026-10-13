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
import { recordFailure, withSpan } from "./spans";
import { telemetryStatus } from "./telemetry";
import { z } from "zod";

const tokenCount = z.number().int().nonnegative();
const usageSchema = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
});
const responseUsageEventSchema = z.object({
  type: z.enum(["response.completed", "response.incomplete"]),
  response: z.object({
    usage: z.object({ input_tokens: tokenCount, output_tokens: tokenCount }),
  }),
});
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
  // Pi owns error normalization; the forwarding stream only keeps the active
  // generation span alive until every provider event has been observed.
  withSpan(
    "model.generate",
    {
      "langfuse.observation.type": "generation",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": model.id,
      "gen_ai.system":
        new URL(model.baseUrl).hostname === "api.openai.com"
          ? "openai"
          : "openai-compatible",
    },
    async (span) => {
      if (span.isRecording() && telemetryStatus().includeContent)
        span.setAttribute(
          "langfuse.observation.input",
          JSON.stringify(context.messages),
        );
      let reportedUsage = false;
      let completionStarted = false;
      const stream = start({
        onPayload: async (payload, requestModel) => {
          const replacement = await options.onPayload?.(payload, requestModel);
          if (span.isRecording()) {
            // Inspect only allowlisted sampling fields after the caller's final
            // payload transformation; headers, credentials and prompts stay out.
            const parameters = modelParametersSchema.safeParse(
              replacement === undefined ? payload : replacement,
            );
            if (parameters.success)
              span.setAttribute(
                "langfuse.observation.model.parameters",
                JSON.stringify(parameters.data),
              );
          }
          return replacement;
        },
        onProviderStreamEvent: async (data, requestModel) => {
          let chunkReportedUsage = false;
          if (model.api === "openai-responses")
            chunkReportedUsage =
              responseUsageEventSchema.safeParse(data).success;
          if (typeof data === "object" && data !== null) {
            if ("usage" in data) {
              const usage = usageSchema.safeParse(data.usage);
              if (usage.success) chunkReportedUsage = true;
            }
            if (
              "choices" in data &&
              Array.isArray(data.choices) &&
              data.choices.length
            ) {
              const choice: unknown = data.choices[0];
              if (
                typeof choice === "object" &&
                choice !== null &&
                "usage" in choice &&
                choice.usage != null
              ) {
                const usage = usageSchema.safeParse(choice.usage);
                if (usage.success) chunkReportedUsage = true;
              }
            }
          }
          await options.onProviderStreamEvent?.(data, requestModel);
          // A throwing caller observer prevents Pi from normalizing this chunk.
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
          const response = event.type === "done" ? event.message : event.error;
          if (reportedUsage && span.isRecording()) {
            const usage = response.usage;
            const reasoningTokens =
              usage.reasoning !== undefined && usage.reasoning <= usage.output
                ? usage.reasoning
                : 0;
            // Pi already separates cache reads/writes from input; reasoning is
            // a subset of output. Langfuse flat usage uses exclusive buckets.
            span.setAttribute(
              "langfuse.observation.usage_details",
              JSON.stringify({
                input: usage.input,
                output: usage.output - reasoningTokens,
                ...(usage.cacheRead > 0
                  ? { input_cached_tokens: usage.cacheRead }
                  : {}),
                ...(usage.cacheWrite > 0
                  ? { input_cache_creation: usage.cacheWrite }
                  : {}),
                ...(reasoningTokens > 0
                  ? { output_reasoning_tokens: reasoningTokens }
                  : {}),
                total: usage.totalTokens,
              }),
            );
          }
          span.setAttribute(
            "gen_ai.response.finish_reason",
            response.stopReason,
          );
          if (response.responseModel)
            span.setAttribute("gen_ai.response.model", response.responseModel);
          if (span.isRecording() && telemetryStatus().includeContent)
            span.setAttribute(
              "langfuse.observation.output",
              JSON.stringify(response.content),
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
            recordFailure(span, new Error("Model output token limit reached"));
        }
        output.push(event);
      }
    },
  ).catch(async (error: unknown) => {
    const failed = lazyStream(model, async () => {
      throw error;
    });
    for await (const event of failed) output.push(event);
  });
  return output;
}
