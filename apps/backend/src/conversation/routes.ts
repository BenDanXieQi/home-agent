import { Hono } from "hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { createPerceptionStream } from "../perception/stream";
import type { createSpeechInbox } from "./speech-inbox";

export function createSpeechRoutes(
  inbox: ReturnType<typeof createSpeechInbox>,
  port: number,
  shutdown: AbortSignal,
) {
  return new Hono()
    .use(requireLocalAccess([port, 5173], { webEntry: true }))
    .use(async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get("/", (c) => c.json(inbox.snapshot()))
    .get(
      "/stream",
      createPerceptionStream(inbox, () => inbox.snapshot(), shutdown),
    );
}
