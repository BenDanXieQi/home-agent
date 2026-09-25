import { hc } from "hono/client";
import type { createApp } from "./app";

// Compile the inferred RPC surface once; the type-only server import is erased.
const client = hc<ReturnType<typeof createApp>>("");
export type BackendClient = typeof client;
export const createBackendClient = (
  ...args: Parameters<typeof hc>
): BackendClient => hc<ReturnType<typeof createApp>>(...args);
