import { createWindowRoutes } from "./window/routes";
import { Hono } from "hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { perceptionSnapshotSchema } from "@home-agent/api/contracts";
import type { createPerceptionService } from "./service";
import { createSnapshotStream } from "../http/snapshot-stream";
import { createImageUpload } from "./image-upload";

export function createPerceptionRoutes(
  service: ReturnType<typeof createPerceptionService>,
  port: number,
  shutdown: AbortSignal,
  requestTimeoutMs: number,
) {
  const uploadImage = createImageUpload(service, shutdown, requestTimeoutMs);
  function snapshot() {
    const view = service.snapshot();
    return perceptionSnapshotSchema.parse({
      sequence: view.sequence,
      householdVersion: view.householdVersion,
      instanceId: view.instanceId,
      status: view.status,
      rejectedRetiredResults: view.rejectedRetiredResults,
      error: view.error,
      settings: view.config,
      resources: view.resources,
      compute: view.compute,
      model: view.model
        ? { sha256: view.model.sha256, provider: view.model.provider }
        : null,
      sources: view.sources,
      audio: view.audio,
    });
  }
  return new Hono()
    .use(requireLocalAccess([port, 5173], { webEntry: true }))
    .get("/", (c) => c.json(snapshot()))
    .get("/stream", createSnapshotStream(service, snapshot, shutdown))
    .post("/images/detect", async (c) => c.json(await uploadImage(c.req.raw)))
    .post("/retry", async (c) => {
      await service.retry();
      return c.json(snapshot());
    })
    .route("/windows", createWindowRoutes(service, shutdown));
}
