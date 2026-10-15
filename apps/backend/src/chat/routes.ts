import { chatInputSchema } from "@home-agent/agent/assistant/contracts";
import { validateJson } from "@home-agent/api/errors/hono";
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
    .post("/", validateJson(chatInputSchema), async (c) =>
      c.json(await agent.chat(c.req.valid("json"), c.req.raw.signal)),
    );
}
