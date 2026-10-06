import type { createApp } from "./app";

/** Server-owned route declarations; no server runtime is loaded by clients. */
export type BackendApp = ReturnType<typeof createApp>;
