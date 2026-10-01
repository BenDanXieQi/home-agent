import { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import {
  mediaRequestSchema,
  mediaSelectionSchema,
} from "@home-agent/api/contracts";
import type { createPerceptionService } from "../service";
import { WindowMediaError } from "../media/window-media";

const mediaReadSelectionSchema = mediaSelectionSchema.extend({
  includeAudio: z
    .stringbool({ truthy: ["true"], falsy: ["false"] })
    .prefault("false"),
});

const mediaErrorStatus = {
  not_found: 404,
  unavailable: 410,
  ineligible: 409,
  not_ready: 409,
  capacity: 429,
} as const;

export function createWindowRoutes(
  service: ReturnType<typeof createPerceptionService>,
  shutdown: AbortSignal,
) {
  return new Hono()
    .onError((error, c) => {
      if (error instanceof WindowMediaError)
        return c.json({ error: error.message }, mediaErrorStatus[error.reason]);
      throw error;
    })
    .get("/", (c) => c.json(service.windows()))
    .get("/:id", (c) => {
      const window = service
        .windows()
        .windows.find((entry) => entry.id === c.req.param("id"));
      return window
        ? c.json(window)
        : c.json({ error: "Window unavailable" }, 404);
    })
    .post("/:id/media", bodyLimit({ maxSize: 1024 }), async (c) => {
      const input = mediaRequestSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!input.success)
        return c.json({ error: "Invalid media request" }, 400);
      const result = service.media.request(c.req.param("id"), input.data);
      return c.json(result, result.state === "generating" ? 202 : 200);
    })
    .get("/:id/media/:representation", (c) => {
      const selection = mediaReadSelectionSchema.safeParse({
        representation: c.req.param("representation"),
        includeAudio: c.req.query("includeAudio"),
      });
      if (!selection.success)
        return c.json({ error: "Invalid media selection" }, 400);
      return c.json(service.media.view(c.req.param("id"), selection.data));
    })
    .get("/:id/media/:representation/:mediaId", (c) => {
      const selection = mediaReadSelectionSchema.safeParse({
        representation: c.req.param("representation"),
        includeAudio: c.req.query("includeAudio"),
      });
      if (!selection.success)
        return c.json({ error: "Invalid media selection" }, 400);
      const result = service.media.read(
        c.req.param("id"),
        selection.data,
        c.req.param("mediaId"),
        AbortSignal.any([shutdown, c.req.raw.signal]),
      );
      return new Response(result.stream, {
        headers: {
          "Content-Type": result.contentType,
          "Content-Length": String(result.bytes),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
}
