import { AppError } from "@home-agent/api/errors";
import { errorResponse, readJsonBody } from "@home-agent/api/errors/hono";
import type { ConfigResponse } from "@home-agent/api/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Environment } from "../environment";
import type { AppContext } from "../app-context";
import { requireLocalManagementAccess } from "../middleware/local-management";
import type { ConnectionStore } from "./store";

export function createConnectionRoutes(
  environment: Environment,
  connectionStore: ConnectionStore,
) {
  return new Hono<AppContext>()
    .use(requireLocalManagementAccess(environment))
    .get("/", async (c) => {
      const configuration = await connectionStore.read();
      return c.json({
        config: configuration,
        writable: await connectionStore.isWritable(),
        path: connectionStore.path,
      } satisfies ConfigResponse);
    })
    .put(
      "/",
      bodyLimit({
        maxSize: 16_384,
        onError: (c) =>
          errorResponse(
            c,
            new AppError("request_too_large", { params: { maxBytes: 16384 } }),
          ),
      }),
      async (c) => {
        const input = await readJsonBody(c);
        const configuration = await connectionStore.save(input);
        return c.json({
          config: configuration,
          writable: await connectionStore.isWritable(),
          path: connectionStore.path,
        } satisfies ConfigResponse);
      },
    );
}
