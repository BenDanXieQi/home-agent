import { streamOperation } from "@home-agent/api/http/stream-operation";
import { createRouteApp, type RouteContext } from "../definition";
import { validateJson } from "@home-agent/api/errors/hono";
import { agentWorkflowInputSchema } from "../../workflows/contracts.generated";

export function createRoutes({ workflows }: Pick<RouteContext, "workflows">) {
  return createRouteApp().post(
    "/workflows",
    validateJson(agentWorkflowInputSchema),
    (c) => {
      c.env.timeout(c.req.raw, 0);
      const input = c.req.valid("json");
      return streamOperation(c, (signal, receive) =>
        workflows.run(input, signal, receive),
      );
    },
  );
}
