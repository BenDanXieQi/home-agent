import { createRouteApp, type RouteContext } from "./definition";
import { createRoutes as createRoutes0 } from "./context-receipts/route";
import { createRoutes as createRoutes1 } from "./conversation/route";
import { createRoutes as createRoutes2 } from "./media-analysis/route";
import { createRoutes as createRoutes3 } from "./workflows/route";

export function createRegisteredRoutes(context: RouteContext) {
  return createRouteApp()
    .route("/api", createRoutes0(context))
    .route("/api", createRoutes1(context))
    .route("/api", createRoutes2(context))
    .route("/api", createRoutes3(context));
}
