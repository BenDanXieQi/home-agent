import { createRouteApp, type RouteContext } from "./definition";
import { createRegisteredRoutes } from "./registry.generated";
import { handleHttpError, handleNotFound } from "@home-agent/api/errors/hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { httpTracing } from "@home-agent/observability";
export function createAgentRoutes({
  port,
  ...context
}: RouteContext & { port: number }) {
  const app = createRouteApp();

  app.use(
    httpTracing(
      "agent",
      (request) =>
        request.method === "POST" &&
        ["/api/chat", "/api/workflows"].includes(request.path),
    ),
  );

  app.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });

  app.onError(handleHttpError);
  app.notFound(handleNotFound);

  return app
    .get("/health", (c) =>
      c.json({
        status: "ok",
        service: "home-agent",
        runtime: "bun",
      }),
    )
    .use(requireLocalAccess([port]))
    .route("/", createRegisteredRoutes(context));
}
