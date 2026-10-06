import { createDeepAgent, StateBackend } from "deepagents";
import { createModel } from "@home-agent/model";
import type { Config } from "./config";

export function createAssistant(config: Config) {
  const model = createModel(config, {
    maxRetries: 0,
    timeout: config.AGENT_RUN_TIMEOUT_MS,
    maxTokens: config.AGENT_MAX_OUTPUT_TOKENS,
  });
  if (!model) return undefined;
  return createDeepAgent({
    model,
    backend: new StateBackend(),
    systemPrompt:
      "你是家庭助手，使用用户的语言回答。目前未接入家庭资料、设备、感知、通知或持久记忆。不能声称知道实际家庭状态、已控制设备或已安排提醒。每次请求独立处理，不声称记得此前对话。",
  });
}
