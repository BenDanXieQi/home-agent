import { once } from "node:events";
import { streamOperation } from "@home-agent/api/http/stream-operation";
import { AppError, validationIssues } from "@home-agent/api/errors";
import { validator } from "hono/validator";
import { mediaAgentHistoryQuerySchema } from "../../media-analysis/session";
import { createRouteApp, type RouteContext } from "../definition";

export function createRoutes({
  mediaAnalysis,
  contextReader,
}: Pick<RouteContext, "mediaAnalysis" | "contextReader">) {
  function requireAgent() {
    if (!mediaAnalysis) throw new AppError("not_found");
    return mediaAnalysis;
  }
  return createRouteApp()
    .get("/media-analysis", (c) =>
      c.json(
        mediaAnalysis?.snapshot() ?? {
          enabled: false,
          entries: [],
          history: { entries: [], nextCursor: null },
          observationTargets: [],
        },
      ),
    )
    .get("/media-analysis/stream", (c) => {
      c.env.timeout(c.req.raw, 0);
      return streamOperation(c, async (signal, receive) => {
        if (!mediaAnalysis) {
          await receive({
            enabled: false,
            entries: [],
            history: { entries: [], nextCursor: null },
            observationTargets: [],
          });
          if (!signal.aborted) await once(signal, "abort");
          return undefined;
        }
        return mediaAnalysis.watch(signal, receive);
      });
    })
    .get(
      "/media-analysis/history",
      validator("query", (value) => {
        const parsed = mediaAgentHistoryQuerySchema.safeParse(value);
        if (!parsed.success)
          throw new AppError("invalid_request", {
            issues: validationIssues(parsed.error),
          });
        return parsed.data;
      }),
      async (c) =>
        c.json(
          await contextReader.readCurrent(c.req.raw.signal, (signal) =>
            requireAgent().history(c.req.valid("query").before, signal),
          ),
        ),
    )
    .get("/media-analysis/:id/stream", (c) => {
      const agent = requireAgent();
      const id = c.req.param("id");
      agent.detail(id);
      c.env.timeout(c.req.raw, 0);
      return streamOperation(c, (signal, receive) =>
        agent.watch(signal, receive, id),
      );
    })
    .get("/media-analysis/:id", (c) =>
      c.json(requireAgent().detail(c.req.param("id"))),
    )
    .get("/media-analysis/:id/media/:index", (c) => {
      const index = Number(c.req.param("index"));
      if (!Number.isSafeInteger(index) || index < 0)
        throw new AppError("invalid_request");
      const media = requireAgent().media(c.req.param("id"), index);
      return new Response(media.data, {
        headers: {
          "Content-Type": media.contentType,
          "Cache-Control": "no-store",
        },
      });
    });
}
