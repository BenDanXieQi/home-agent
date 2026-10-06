import { chatInputSchema } from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
    .post(
      "/",
      bodyLimit({
        maxSize: 32768,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
      validateJson(chatInputSchema),
      async (c) =>
        c.json(await agent.chat(c.req.valid("json"), c.req.raw.signal)),
    );
}
