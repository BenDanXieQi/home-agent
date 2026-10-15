import {
  hasApi,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { AppError } from "@home-agent/api/errors";

export function completeStructuredOutput(
  models: Models,
  model: Model<Api>,
  context: Parameters<Models["complete"]>[1],
  options: { timeoutMs: number; maxTokens: number; signal: AbortSignal },
) {
  const tool = context.tools?.[0];
  if (!tool || context.tools?.length !== 1)
    throw new AppError("agent_execution_failed", {
      cause: new Error(
        "A structured workflow must offer exactly one output tool",
      ),
    });

  const requestOptions = {
    ...options,
    maxTokens: Math.min(options.maxTokens, model.maxTokens),
    maxRetries: 0,
  };

  if (hasApi(model, "openai-completions"))
    return models.complete(model, context, {
      ...requestOptions,
      toolChoice: { type: "function", function: { name: tool.name } },
      samplingParams: { parallel_tool_calls: false },
    });

  if (
    hasApi(model, "openai-responses") ||
    hasApi(model, "azure-openai-responses")
  )
    return models.complete(model, context, {
      ...requestOptions,
      toolChoice: { type: "function", name: tool.name },
      samplingParams: { parallel_tool_calls: false },
    });

  if (hasApi(model, "anthropic-messages")) {
    const toolChoice = {
      type: "tool" as const,
      name: tool.name,
      disable_parallel_tool_use: true,
    };
    return models.complete(model, context, { ...requestOptions, toolChoice });
  }

  if (hasApi(model, "bedrock-converse-stream"))
    return models.complete(model, context, {
      ...requestOptions,
      toolChoice: { type: "tool", name: tool.name },
    });

  if (hasApi(model, "mistral-conversations") || hasApi(model, "pi-messages"))
    return models.complete(model, context, {
      ...requestOptions,
      toolChoice: { type: "function", function: { name: tool.name } },
    });

  if (hasApi(model, "google-generative-ai") || hasApi(model, "google-vertex"))
    return models.complete(model, context, {
      ...requestOptions,
      toolChoice: "any",
    });

  if (hasApi(model, "openai-codex-responses"))
    return models.complete(model, context, {
      ...requestOptions,
      toolChoice: "required",
    });

  throw new AppError("agent_execution_failed", {
    cause: new Error(
      `The model API has no structured workflow tool-choice mapping: ${model.api}`,
    ),
  });
}
