import { createAgentRuntime } from "../../runtime";
import type { Models } from "@earendil-works/pi-ai";
import type { ConfiguredModel } from "@home-agent/configuration/models";
import type { Config } from "../../config";
import { spatialPlanningInstructions } from "./instructions";

export function createSpatialPlanning(
  config: Config,
  models: Models,
  model: ConfiguredModel | undefined,
  tools: NonNullable<Parameters<typeof createAgentRuntime>[2]["tools"]>,
) {
  if (!model) return undefined;
  return createAgentRuntime(models, model, {
    name: "spatial-planning",
    tools,
    timeoutMs: config.AGENT_RUN_TIMEOUT_MS,
    maxTokens: config.AGENT_MAX_OUTPUT_TOKENS,
    instructions: spatialPlanningInstructions,
  });
}
