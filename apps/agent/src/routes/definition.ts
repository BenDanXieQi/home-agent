import { createFactory } from "hono/factory";
import type { createAssistant } from "../assistant/assistant";
import type { createConversationInteraction } from "../assistant/conversation";
import type { createContextReceiver } from "../context/receiver";
import type { configureWorkflows } from "../workflows";

const factory = createFactory<{ Bindings: Bun.Server<unknown> }>();
export const createRouteApp = factory.createApp;

export type RouteContext = {
  context: Pick<
    ReturnType<typeof createContextReceiver>,
    "snapshot" | "receiptIndex" | "journalId" | "receipt"
  >;
  assistant:
    | Pick<
        NonNullable<Awaited<ReturnType<typeof createAssistant>>>,
        "root" | "sessionId" | "tracing"
      >
    | undefined;
  budget: Pick<
    Parameters<typeof createConversationInteraction>[1],
    "timeoutMs"
  >;
  workflows: Pick<
    ReturnType<ReturnType<typeof configureWorkflows>["create"]>,
    "run"
  >;
};
