import { AppError } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import {
  serviceConfigurationSchema,
  type ConfigResponse,
} from "@home-agent/api/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireLocalAccess } from "@home-agent/api/local-access";
import type { ConnectionStore } from "./store";

export function createConnectionRoutes(
  port: number,
  connectionStore: ConnectionStore,
) {
  return new Hono()
    .use(requireLocalAccess([port, 5173]))
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
      validateJson(
        serviceConfigurationSchema,
        "connection_config_input_invalid",
      ),
      async (c) => {
        const input = c.req.valid("json");
        const configuration = await connectionStore.save(input);
        return c.json({
          config: configuration,
          writable: await connectionStore.isWritable(),
          path: connectionStore.path,
        } satisfies ConfigResponse);
      },
    );
}
