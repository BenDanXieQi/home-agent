import { createRouteApp, type RouteContext } from "../definition";
import { chatInputSchema, chatResponseSchema } from "../../assistant/contracts";
import { AppError } from "@home-agent/api/errors";
import { validateJson } from "@home-agent/api/errors/hono";
import { createConversationInteraction } from "../../assistant/conversation";

export function createRoutes({
  assistant,
  budget,
}: Pick<RouteContext, "assistant" | "budget">) {
  const conversation = assistant
    ? createConversationInteraction(assistant.root, {
        sessionId: assistant.sessionId,
        tracing: assistant.tracing,
        timeoutMs: budget.timeoutMs,
      })
    : undefined;

  return createRouteApp().post(
    "/chat",
    validateJson(chatInputSchema),
    async (c) => {
      if (!conversation) throw new AppError("model_not_configured");

      c.env.timeout(c.req.raw, 0);
      const answer = await conversation.submitAndWait(
        c.req.valid("json").message,
        c.req.raw.signal,
      );

      const response = chatResponseSchema.safeParse({ answer });
      if (!response.success)
        throw new AppError("agent_execution_failed", {
          cause: response.error,
        });

      return c.json(response.data);
    },
  );
}
