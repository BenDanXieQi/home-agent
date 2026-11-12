import { createRouteApp, type RouteContext } from "../definition";
import { chatInputSchema, chatResponseSchema } from "../../assistant/contracts";
import { AppError } from "@home-agent/api/errors";
import { validateJson } from "@home-agent/api/errors/hono";
import { createConversationInteraction } from "../../assistant/conversation";
import { streamOperation } from "@home-agent/api/http/stream-operation";

export function createRoutes({
  assistant,
  harness,
  contextReader,
}: Pick<RouteContext, "assistant" | "harness" | "contextReader">) {
  const conversation = assistant
    ? createConversationInteraction(assistant, harness)
    : undefined;

  return createRouteApp().post("/chat", validateJson(chatInputSchema), (c) => {
    if (!conversation) throw new AppError("model_not_configured");

    c.env.timeout(c.req.raw, 0);
    return streamOperation(c, async (signal, receive) => {
      const answer = await contextReader.readCurrent(signal, (currentSignal) =>
        conversation.submitAndWait(
          c.req.valid("json").message,
          currentSignal,
          receive,
        ),
      );
      const response = chatResponseSchema.safeParse({ answer });
      if (!response.success)
        throw new AppError("agent_execution_failed", {
          cause: response.error,
        });
      return response.data;
    });
  });
}
