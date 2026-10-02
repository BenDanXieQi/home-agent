import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import type { Config } from "./config";

export function createAgentModel(
  config: Config,
  options: Pick<
    ChatOpenAIFields,
    "streaming" | "streamUsage" | "maxRetries" | "timeout" | "maxTokens"
  >,
) {
  if (!config.OPENAI_API_KEY || !config.AGENT_MODEL) return undefined;
  return new ChatOpenAI({
    ...options,
    model: config.AGENT_MODEL,
    apiKey: config.OPENAI_API_KEY,
    ...(config.AGENT_THINKING
      ? { modelKwargs: { thinking: { type: config.AGENT_THINKING } } }
      : {}),
    ...(config.OPENAI_BASE_URL
      ? { configuration: { baseURL: config.OPENAI_BASE_URL } }
      : {}),
  });
}
