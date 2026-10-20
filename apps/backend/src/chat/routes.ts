import { chatInputSchema } from "@home-agent/agent/assistant/contracts";
import { validateJson } from "@home-agent/api/errors/hono";
import { streamOperation } from "@home-agent/api/http/stream-operation";
import { Hono } from "hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import type { createAgentClient } from "../agent-client";

export function createChatRoutes({
  port,
  agent,
}: {
  port: number;
  agent: Pick<ReturnType<typeof createAgentClient>, "chat">;
}) {
  return new Hono()
    .use(requireLocalAccess([port, 5173], { webEntry: true }))
    .post("/", validateJson(chatInputSchema), (c) => {
      const input = c.req.valid("json");
      return streamOperation(c, (signal, receive) =>
        agent.chat(input, signal, receive),
      );
    });
}
