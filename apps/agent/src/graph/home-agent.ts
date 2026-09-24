import { SystemMessage, type UsageMetadata } from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { telemetryStatus, withSpan } from "@home-agent/observability";
import type { Config } from "../config";
import type { AgentDatabase } from "../db";

export function createHomeAgent(
  config: Config,
  checkpointer?: AgentDatabase["checkpointer"],
) {
  if (!config.OPENAI_API_KEY || !config.AGENT_MODEL) return undefined;
  const modelName = config.AGENT_MODEL;
  const model = new ChatOpenAI({
    model: modelName,
    apiKey: config.OPENAI_API_KEY,
    streaming: true,
    streamUsage: true,
    maxRetries: 1,
    timeout: 60_000,
    ...(config.OPENAI_BASE_URL
      ? { configuration: { baseURL: config.OPENAI_BASE_URL } }
      : {}),
  });

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("model", async (state, options) => {
      const messages = [
        new SystemMessage(
          "You are a smart-home assistant. Household data, device tools, and automation are not connected yet. Never claim to know actual device state or to have performed an action. Explain missing capabilities honestly. Reply in the user's language.",
        ),
        ...state.messages,
      ];
      return withSpan(
        `chat ${modelName}`,
        {
          "langsmith.span.kind": "llm",
          "gen_ai.operation.name": "chat",
          "gen_ai.system": config.OPENAI_BASE_URL
            ? "openai-compatible"
            : "openai",
          "gen_ai.request.model": modelName,
        },
        async (span) => {
          if (telemetryStatus().includeContent) {
            span.setAttribute(
              "gen_ai.prompt",
              JSON.stringify({
                messages: messages.map((message) => ({
                  role:
                    message.getType() === "human" ? "user" : message.getType(),
                  content: message.content,
                })),
              }),
            );
          }
          const response = await model.invoke(messages, options);
          const usage = response.usage_metadata as UsageMetadata | undefined;
          if (usage) {
            span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens);
            span.setAttribute(
              "gen_ai.usage.output_tokens",
              usage.output_tokens,
            );
            span.setAttribute("gen_ai.usage.total_tokens", usage.total_tokens);
          }
          const responseModel: unknown = response.response_metadata.model_name;
          if (typeof responseModel === "string")
            span.setAttribute("gen_ai.response.model", responseModel);
          if (telemetryStatus().includeContent) {
            span.setAttribute(
              "gen_ai.completion",
              JSON.stringify({
                messages: [{ role: "assistant", content: response.content }],
              }),
            );
          }
          return { messages: [response] };
        },
      );
    })
    .addEdge(START, "model")
    .addEdge("model", END)
    .compile(checkpointer ? { checkpointer } : {});
  return { graph };
}
