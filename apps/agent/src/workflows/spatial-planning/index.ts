import { createDeepAgent, StateBackend } from "deepagents";
import { createModel } from "@home-agent/model";
import type { Config } from "../../config";
import { spatialPlanningInstructions } from "./instructions";

export function createSpatialPlanning(
  config: Config,
  tools: NonNullable<
    NonNullable<Parameters<typeof createDeepAgent>[0]>["tools"]
  >,
) {
  const model = createModel(config, {
    maxRetries: 0,
    timeout: config.AGENT_RUN_TIMEOUT_MS,
    maxTokens: config.AGENT_MAX_OUTPUT_TOKENS,
  });
  if (!model) return undefined;
  return createDeepAgent({
    name: "spatial-planning",
    model,
    tools,
    backend: new StateBackend(),
    systemPrompt: spatialPlanningInstructions,
  });
}
