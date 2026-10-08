import { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import {
  mediaRequestSchema,
  mediaSelectionSchema,
  windowSourceSchema,
  windowListQuerySchema,
  windowSummarySchema,
  type ErrorCode,
} from "@home-agent/api/contracts";
import { AppError, validationIssues } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import type { createPerceptionService } from "../service";
import { WindowMediaError } from "../media/window-media";
import { HouseholdError } from "../../household/errors";
import { householdHttpError } from "../../household/http-errors";

const windowQuerySchema = windowListQuerySchema.extend({
  before: z.string().transform(Number).pipe(z.number().finite()).optional(),
  start: z.string().transform(Number).pipe(z.number().finite()).optional(),
  end: z.string().transform(Number).pipe(z.number().finite()).optional(),
  channel: z.string().transform(Number).pipe(windowSourceSchema.shape.channel),
});
const windowQuery = validator("query", (value) => {
  const parsed = windowQuerySchema.safeParse(value);
  if (!parsed.success)
    throw new AppError("invalid_request", {
      issues: validationIssues(parsed.error),
    });
  if (
    (parsed.data.beforeId !== undefined && parsed.data.before === undefined) ||
    (parsed.data.start !== undefined &&
      parsed.data.end !== undefined &&
      parsed.data.start >= parsed.data.end)
  )
    throw new AppError("invalid_request");
  return parsed.data;
});

const mediaQuerySchema = z.object({
  includeAudio: z
    .stringbool({ truthy: ["true"], falsy: ["false"] })
    .prefault("false"),
});

const mediaQuery = validator(
  "query",
  (value: z.input<typeof mediaQuerySchema>) => {
    const parsed = mediaQuerySchema.safeParse(value);
    if (!parsed.success)
      throw new AppError("invalid_request", {
        issues: validationIssues(parsed.error),
      });
    return parsed.data;
  },
);
function parseMediaSelection(
  representation: string,
  query: z.output<typeof mediaQuerySchema>,
) {
  const parsed = mediaSelectionSchema.safeParse({ representation, ...query });
  if (!parsed.success)
    throw new AppError("invalid_request", {
      issues: validationIssues(parsed.error),
    });
  return parsed.data;
}

const mediaErrorCode = {
  not_found: "not_found",
  unavailable: "perception_media_unavailable",
  ineligible: "perception_media_ineligible",
  not_ready: "perception_media_not_ready",
  capacity: "perception_media_capacity",
} as const satisfies Record<WindowMediaError["reason"], ErrorCode>;

export function createWindowRoutes(
  service: ReturnType<typeof createPerceptionService>,
  shutdown: AbortSignal,
) {
  return new Hono()
    .onError((error, c) => {
      if (c.req.raw.signal.aborted)
        return errorResponse(c, new AppError("request_cancelled"));
      if (error instanceof HouseholdError)
        return errorResponse(c, householdHttpError(error));
      if (error instanceof WindowMediaError)
        return errorResponse(c, new AppError(mediaErrorCode[error.reason]));
      throw error;
    })
    .get("/", windowQuery, async (c) =>
      c.json(await service.listWindows(c.req.valid("query"), c.req.raw.signal)),
    )
    .get("/cached", windowQuery, (c) =>
      c.json(service.windows(c.req.valid("query"))),
    )
    .get("/:id", async (c) => {
      const id = windowSummarySchema.shape.id.safeParse(c.req.param("id"));
      if (!id.success) throw new AppError("invalid_request");
      const window = await service.readWindow(id.data, c.req.raw.signal);
      if (!window) throw new AppError("not_found");
      return c.json(window);
    })
    .post(
      "/:id/media",
      bodyLimit({ maxSize: 1024 }),
      validateJson(mediaRequestSchema),
      (c) => {
        const result = service.media.request(
          c.req.param("id"),
          c.req.valid("json"),
        );
        return c.json(
          result,
          result.state === "queued" || result.state === "generating"
            ? 202
            : 200,
        );
      },
    )
    .get("/:id/media/:representation", mediaQuery, (c) => {
      const selection = parseMediaSelection(
        c.req.param("representation"),
        c.req.valid("query"),
      );
      return c.json(service.media.view(c.req.param("id"), selection));
    })
    .get("/:id/media/:representation/:mediaId", mediaQuery, (c) => {
      const selection = parseMediaSelection(
        c.req.param("representation"),
        c.req.valid("query"),
      );
      const result = service.media.read(
        c.req.param("id"),
        selection,
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
