import {
  SystemMessage,
  type AIMessageChunk,
  type StandardMessageStructure,
} from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { createAgentModel } from "../model";
import { telemetryStatus, withSpan } from "@home-agent/observability";
import type { Config } from "../config";
import type { AgentDatabase } from "../db";

export function createHomeAgent(
  config: Config,
  checkpointer?: AgentDatabase["checkpointer"],
) {
  const model = createAgentModel(config, {
    streaming: true,
    streamUsage: true,
    maxRetries: 1,
    timeout: 60_000,
  });
  if (!model) return undefined;
  const modelName = model.model;

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
          const response: AIMessageChunk<StandardMessageStructure> =
            await model.invoke(messages, options);
          const usage = response.usage_metadata;
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
