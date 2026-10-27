import { once } from "node:events";
import { streamOperation } from "@home-agent/api/http/stream-operation";
import { AppError } from "@home-agent/api/errors";
import { createRouteApp, type RouteContext } from "../definition";

export function createRoutes({
  mediaAnalysis,
}: Pick<RouteContext, "mediaAnalysis">) {
  function requireAgent() {
    if (!mediaAnalysis) throw new AppError("not_found");
    return mediaAnalysis;
  }
  return createRouteApp()
    .get("/media-analysis", (c) =>
      c.json(mediaAnalysis?.snapshot() ?? { enabled: false, entries: [] }),
    )
    .get("/media-analysis/stream", (c) => {
      c.env.timeout(c.req.raw, 0);
      return streamOperation(c, async (signal, receive) => {
        if (!mediaAnalysis) {
          await receive({ enabled: false, entries: [] });
          if (!signal.aborted) await once(signal, "abort");
          return undefined;
        }
        return mediaAnalysis.watch(signal, receive);
      });
    })
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
