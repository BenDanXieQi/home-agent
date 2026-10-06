import { hc } from "hono/client";
import type { BackendApp } from "@home-agent/backend/rpc";

export const createBackendClient = (...args: Parameters<typeof hc>) =>
  hc<BackendApp>(...args);
export type BackendClient = ReturnType<typeof createBackendClient>;
