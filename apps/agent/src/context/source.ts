import type { z } from "zod";
import type { consumeEventStream } from "@home-agent/api/http/event-stream";
import type { requestJson } from "@home-agent/api/http/request-json";
import type {
  agentHistoryQuerySchema,
  agentMaterialQuerySchema,
} from "@home-agent/api/agent-context";

type JsonRequest = Parameters<typeof requestJson>[0];

export type ContextSource = {
  stream: Parameters<typeof consumeEventStream>[0]["request"];
  history: (
    input: z.input<typeof agentHistoryQuerySchema>,
    signal: AbortSignal,
  ) => ReturnType<JsonRequest>;
  material: (
    input: z.input<typeof agentMaterialQuerySchema>,
    signal: AbortSignal,
  ) => ReturnType<JsonRequest>;
};
