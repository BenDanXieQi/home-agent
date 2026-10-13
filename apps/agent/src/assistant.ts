import { createAgentRuntime } from "./runtime";
import type { Models } from "@earendil-works/pi-ai";
import type { ConfiguredModel } from "@home-agent/configuration/models";
import type { Config } from "./config";

export function createAssistant(
  config: Config,
  models: Models,
  model: ConfiguredModel | undefined,
) {
  if (!model) return undefined;
  return createAgentRuntime(models, model, {
    name: "household-assistant",
    timeoutMs: config.AGENT_RUN_TIMEOUT_MS,
    maxTokens: config.AGENT_MAX_OUTPUT_TOKENS,
    instructions:
      "你是家庭助手，使用用户的语言回答。目前未接入家庭资料、设备、感知、通知或持久记忆。不能声称知道实际家庭状态、已控制设备或已安排提醒。每次请求独立处理，不声称记得此前对话。",
  });
}
