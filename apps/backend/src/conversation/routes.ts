import { Hono } from "hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { createSnapshotStream } from "../http/snapshot-stream";
import type { createSpeechInbox } from "./speech-inbox";

export function createSpeechRoutes(
  inbox: ReturnType<typeof createSpeechInbox>,
  port: number,
  shutdown: AbortSignal,
) {
  return new Hono()
    .use(requireLocalAccess([port, 5173], { webEntry: true }))
    .get("/", (c) => c.json(inbox.snapshot()))
    .get(
      "/stream",
      createSnapshotStream(inbox, () => inbox.snapshot(), shutdown),
    );
}
