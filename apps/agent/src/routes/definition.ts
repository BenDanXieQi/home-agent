import { createFactory } from "hono/factory";
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
  assistant: Parameters<typeof createConversationInteraction>[0] | undefined;
  harness: Parameters<typeof createConversationInteraction>[1];
  workflows: Pick<
    NonNullable<
      ReturnType<ReturnType<typeof configureWorkflows>["register"]>["instance"]
    >,
    "run"
  >;
};
