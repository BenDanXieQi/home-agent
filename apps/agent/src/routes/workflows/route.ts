import { createRouteApp, type RouteContext } from "../definition";
import { validateJson } from "@home-agent/api/errors/hono";
import { agentWorkflowInputSchema } from "@home-agent/api/agent-workflows";

export function createRoutes({ workflows }: Pick<RouteContext, "workflows">) {
  return createRouteApp().post(
    "/workflows",
    validateJson(agentWorkflowInputSchema),
    async (c) => {
      c.env.timeout(c.req.raw, 0);

      return c.json(await workflows.run(c.req.valid("json"), c.req.raw.signal));
    },
  );
}
