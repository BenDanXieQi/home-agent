import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@home-agent/api/errors";
import {
  errorResponse,
  handleHttpError,
  validateJson,
} from "@home-agent/api/errors/hono";
import {
  mijiaPlaybackInputSchema,
  mijiaPlaybackReservationInputSchema,
  mijiaVerificationInputSchema,
  mijiaPlaybackStateSchema,
} from "@home-agent/api/mijia";
import { loginMaterialSchema } from "@home-agent/api/household";
import type { HouseholdRuntime } from "../household/runtime";
import { createHouseholdRoutes } from "../household/routes";
import { requireLocalAccess } from "@home-agent/api/local-access";

export function createMijiaRoutes(port: number, runtime: HouseholdRuntime) {
  const service = runtime.service;
  const commandResult = () => {
    service.flushChanges();
    return { state_version: runtime.version() };
  };
  const app = new Hono();
  app.use(requireLocalAccess([port, 5173]));
  app
    .use(
      bodyLimit({
        maxSize: 70_000,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
    )
    .use(async (c, next) => {
      c.header("Referrer-Policy", "no-referrer");
      c.header("Cache-Control", "no-store");
      await next();
    });
  const routes = app
    .route("/", createHouseholdRoutes(runtime))
    .get("/directory/push", (c) => c.json(service.directoryPushStatus()))
    .get("/login/:id/material", (c) =>
      c.json(
        loginMaterialSchema.parse(service.loginMaterial(c.req.param("id"))),
      ),
    )
    .post("/login", (c) => {
      service.startLogin();
      return c.json(commandResult(), 202);
    })
    .delete(
      "/login/:id",
      (c) => (service.cancelLogin(c.req.param("id")), c.json(commandResult())),
    )
    .post(
      "/login/:id/verify",
      validateJson(mijiaVerificationInputSchema),
      async (c) => {
        const input = c.req.valid("json");
        await service.verifyLogin(c.req.param("id"), input.ticket);
        return c.json(commandResult());
      },
    )
    .post(
      "/connection/retry",
      (c) => (service.requestConnection(), c.json(commandResult(), 202)),
    )
    .delete("/session", async (c) => {
      await runtime.logout();
      return c.json(commandResult());
    })
    .post(
      "/playback/reservations",
      validateJson(mijiaPlaybackReservationInputSchema),
      async (c) => {
        const input = c.req.valid("json");
        const reservation = runtime.reservePlayback(
          input.scope_epoch,
          input.revision,
          input.deviceId,
          input.channel,
        );
        c.header("Location", `/api/mijia/playback/${reservation.id}`);
        return c.json(reservation, 201);
      },
    )
    .get("/playback/:id", (c) =>
      c.json(
        mijiaPlaybackStateSchema.parse(
          service.playbackSnapshot(c.req.param("id")),
        ),
      ),
    )
    .put("/playback/:id", validateJson(mijiaPlaybackInputSchema), async (c) => {
      const input = c.req.valid("json");
      // The request signal rejects pre-aborted work; accepted offers belong to the viewer resource.
      const result = await service.offer(
        input.revision,
        c.req.param("id"),
        input.sdp,
        c.req.raw.signal,
      );
      return c.json(result);
    })
    .delete("/playback/:id", async (c) => {
      await service.release(c.req.param("id"));
      return c.body(null, 204);
    });
  app.onError(handleHttpError);
  return routes;
}
