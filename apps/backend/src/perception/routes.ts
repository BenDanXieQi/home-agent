import { Hono } from "hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { perceptionSnapshotSchema } from "@home-agent/api/contracts";
import type { createPerceptionService } from "./service";
import { createPerceptionStream } from "./stream";

export function createPerceptionRoutes(
  service: ReturnType<typeof createPerceptionService>,
  port: number,
  shutdown: AbortSignal,
) {
  function snapshot() {
    const view = service.snapshot();
    return perceptionSnapshotSchema.parse({
      status: view.status,
      rejectedRetiredResults: view.rejectedRetiredResults,
      error: view.error,
      settings: view.config,
      compute: view.compute,
      model: view.model
        ? { sha256: view.model.sha256, provider: view.model.provider }
        : null,
      sources: view.sources,
    });
  }
  return new Hono()
    .use(requireLocalAccess([port, 5173]))
    .use(async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get("/", (c) => c.json(snapshot()))
    .get("/stream", createPerceptionStream(service, snapshot, shutdown))
    .post("/retry", async (c) => {
      await service.retry();
      return c.json(snapshot());
    });
}
