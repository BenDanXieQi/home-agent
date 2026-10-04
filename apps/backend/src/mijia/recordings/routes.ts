import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import parseRange from "range-parser";
import { mijiaRecordingPlaybackInputSchema } from "@home-agent/api/mijia-recordings";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { MijiaError, safeMijiaError } from "../errors";
import { RecordingResourceError, type createRecordingService } from "./service";

const resourceStatus = {
  not_found: 404,
  not_ready: 409,
  unavailable: 410,
  conflict: 409,
  capacity: 429,
} as const;
function identifier(value: string) {
  const parsed = mijiaRecordingPlaybackInputSchema.shape.id.safeParse(value);
  if (!parsed.success) throw new AppError("invalid_request");
  return parsed.data;
}

export function createRecordingRoutes(
  service: ReturnType<typeof createRecordingService>,
  port: number,
) {
  return new Hono()
    .use(requireLocalAccess([port, 5173], { webEntry: true }))
    .use(async (c, next) => {
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      await next();
    })
    .onError((error, c) => {
      if (error instanceof RecordingResourceError) {
        const problem =
          error.reason === "not_found"
            ? new AppError("not_found")
            : new MijiaError(
                error.reason === "capacity"
                  ? "capacity_exceeded"
                  : error.reason === "conflict"
                    ? "playback_conflict"
                    : "camera_failed",
              );
        return errorResponse(c, problem, resourceStatus[error.reason]);
      }
      return errorResponse(
        c,
        error instanceof AppError ? error : safeMijiaError(error),
      );
    })
    .put(
      "/playback/:id",
      bodyLimit({
        maxSize: 4096,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
      validateJson(mijiaRecordingPlaybackInputSchema),
      (c) => {
        const input = c.req.valid("json");
        if (identifier(c.req.param("id")) !== input.id)
          throw new AppError("invalid_request");
        const state = service.request(input);
        return c.json(state, state.state === "preparing" ? 202 : 200);
      },
    )
    .get("/playback/:id", (c) =>
      c.json(service.state(identifier(c.req.param("id")))),
    )
    .delete("/playback/:id", async (c) => {
      await service.release(identifier(c.req.param("id")));
      return c.body(null, 204);
    })
    .on(["GET", "HEAD"], "/playback/:id/media", (c) => {
      const id = identifier(c.req.param("id"));
      const info = service.mediaInfo(id);
      const headers = new Headers({
        "Content-Type": "video/mp4",
        "Cache-Control": "no-store",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
        ETag: info.etag,
      });
      let start = 0;
      let end = info.bytes - 1;
      let partial = false;
      const requested = c.req.header("Range");
      const ifRange = c.req.header("If-Range");
      if (
        c.req.method === "GET" &&
        requested &&
        (!ifRange || ifRange === info.etag)
      ) {
        const parsed =
          requested.length <= 1024 ? parseRange(info.bytes, requested) : -2;
        if (typeof parsed === "number") {
          headers.set("Content-Range", `bytes */${info.bytes}`);
          headers.set("Content-Length", "0");
          return new Response(null, { status: 416, headers });
        }
        // Only single byte ranges are served; other range units or multipart
        // requests use the complete representation as HTTP permits.
        if (parsed.type === "bytes" && parsed.length === 1) {
          start = parsed[0]!.start;
          end = parsed[0]!.end;
          partial = true;
          headers.set("Content-Range", `bytes ${start}-${end}/${info.bytes}`);
        }
      }
      headers.set("Content-Length", String(end - start + 1));
      if (c.req.method === "HEAD") return new Response(null, { headers });
      const stream = service.read(id, { start, end }, c.req.raw.signal);
      return new Response(stream, { status: partial ? 206 : 200, headers });
    });
}
