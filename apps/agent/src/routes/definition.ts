import { createFactory } from "hono/factory";
import type { createConversationInteraction } from "../assistant/conversation";
import type { createContextReceiver } from "../context/receiver";
import type { createContextReader } from "../context/reader";
import type { configureWorkflows } from "../workflows";

import type { createMediaAnalysisAgent } from "../media-analysis/service";

const factory = createFactory<{ Bindings: Bun.Server<unknown> }>();
export const createRouteApp = factory.createApp;

export type RouteContext = {
  mediaAnalysis: ReturnType<typeof createMediaAnalysisAgent> | undefined;
  context: Pick<
    ReturnType<typeof createContextReceiver>,
    "snapshot" | "receiptIndex" | "journalId" | "receipt"
  >;
  contextReader: Pick<ReturnType<typeof createContextReader>, "readCurrent">;
  assistant: Parameters<typeof createConversationInteraction>[0] | undefined;
  harness: Parameters<typeof createConversationInteraction>[1];
  workflows: Pick<
    NonNullable<
      Awaited<ReturnType<ReturnType<typeof configureWorkflows>["create"]>>
    >,
    "run"
  >;
};
