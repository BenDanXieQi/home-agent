import { hc } from "hono/client";
import type { createApp } from "./app";

// Compile the inferred RPC surface once; the type-only server import is erased.
export const createBackendClient = (...args: Parameters<typeof hc>) =>
  hc<ReturnType<typeof createApp>>(...args);
export type BackendClient = ReturnType<typeof createBackendClient>;
