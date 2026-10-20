import { createBackendClient } from "@home-agent/backend-client";
import type { ContextSource } from "@home-agent/agent/context/source";
import { tracedFetch } from "@home-agent/observability";
import { partial } from "es-toolkit";

export function createContextSource(backendUrl: string) {
  const api = createBackendClient(backendUrl, {
    fetch: partial(tracedFetch, { from: "agent", to: "backend" }),
  }).api.agent.context;
  return {
    stream: (signal) =>
      api.stream.$get(
        {},
        {
          init: { headers: { Accept: "text/event-stream" }, signal },
        },
      ),
    history: (input, signal) =>
      api.history.$post({ json: input }, { init: { signal } }),
    material: (input, signal) =>
      api.material.$post({ json: input }, { init: { signal } }),
  } satisfies ContextSource;
}
