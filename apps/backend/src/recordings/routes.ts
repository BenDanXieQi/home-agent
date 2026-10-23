import { addAbortListener } from "node:events";
import { PassThrough, Readable } from "node:stream";
import FormData from "form-data";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { MediaCapacityError } from "../media/resources";
import { safeMijiaError } from "../mijia/errors";
import { RecordingCoverageError } from "./selection";
import { readMediaInputSchema, type createRecordingsService } from "./service";

export function createRecordingsRoutes(
  service: ReturnType<typeof createRecordingsService>,
  port: number,
) {
  return new Hono()
    .use(requireLocalAccess([port, 5173], { webEntry: true }))
    .onError((error, c) =>
      errorResponse(
        c,
        error instanceof MediaCapacityError
          ? new AppError("perception_media_capacity")
          : error instanceof RecordingCoverageError
            ? new AppError("perception_media_unavailable")
            : error instanceof AppError
              ? error
              : safeMijiaError(error, "camera_failed"),
        error instanceof MediaCapacityError ? 429 : undefined,
      ),
    )
    .post(
      "/media",
      bodyLimit({
        maxSize: 4096,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
      validateJson(readMediaInputSchema),
      async (c) => {
        const controller = new AbortController();
        const requestAbort = addAbortListener(c.req.raw.signal, () =>
          controller.abort(c.req.raw.signal.reason),
        );
        try {
          const result = await service.readMedia(
            c.req.valid("json"),
            controller.signal,
          );
          const signal = controller.signal;
          signal.throwIfAborted();
          const form = new FormData();
          const output = new PassThrough();
          function fail(cause: unknown) {
            const error =
              cause instanceof Error
                ? cause
                : new Error("Media response failed", { cause });
            controller.abort(error);
            form.destroy();
            output.destroy(error);
          }
          form.on("error", fail);
          output.on("error", fail);
          const abort = addAbortListener(signal, () => fail(signal.reason));
          output.once("close", () => {
            if (!output.readableEnded)
              controller.abort(new Error("Media response closed"));
            requestAbort[Symbol.dispose]();
            abort[Symbol.dispose]();
          });
          form.append("metadata", JSON.stringify(result.metadata), {
            contentType: "application/json",
          });
          result.media.forEach((media, index) => {
            const { contentType } = result.metadata.items[index]!;
            const stream = Readable.fromWeb(media);
            stream.on("error", fail);
            form.append("media", stream, {
              filename: `${index + 1}.${contentType === "video/mp4" ? "mp4" : "jpg"}`,
              contentType,
            });
          });
          const response = new Response(
            Readable.toWeb(output, {
              strategy: new ByteLengthQueuingStrategy({
                highWaterMark: output.readableHighWaterMark,
              }),
            }),
            {
              headers: {
                ...form.getHeaders(),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              },
            },
          );
          form.pipe(output);
          return response;
        } catch (cause) {
          controller.abort(cause);
          requestAbort[Symbol.dispose]();
          throw cause;
        }
      },
    );
}
