import { hc } from "hono/client";
import type { BackendApp } from "@home-agent/backend/rpc";

export { agentWorkflowStreamContracts } from "@home-agent/agent/workflows";
export { chatStreamContract } from "@home-agent/agent/assistant/contracts";

export const createBackendClient = (...args: Parameters<typeof hc>) =>
  hc<BackendApp>(...args);
export type BackendClient = ReturnType<typeof createBackendClient>;
