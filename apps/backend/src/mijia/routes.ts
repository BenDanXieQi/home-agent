import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@home-agent/api/errors";
import {
  errorResponse,
  handleHttpError,
  validateJson,
} from "@home-agent/api/errors/hono";
import {
  mijiaHomeSelectionSchema,
  mijiaHomeSelectionInputSchema,
  mijiaDeviceSpecSchema,
  mijiaHomeSchema,
  mijiaPlaybackInputSchema,
  mijiaPlaybackReservationInputSchema,
  mijiaVerificationInputSchema,
  mijiaStateSchema,
  mijiaPollIntervalMs,
  mijiaPlaybackStateSchema,
  type MijiaState,
} from "@home-agent/api/mijia";
import { requireLocalAccess } from "@home-agent/api/local-access";
import type { MijiaService } from "./service";

function stateResponse(c: Context, state: MijiaState, status: 200 | 202 = 200) {
  const snapshot = mijiaStateSchema.parse(state);
  c.header("Retry-After", String(mijiaPollIntervalMs(snapshot) / 1_000));
  if (status === 202) c.header("Location", "/api/mijia/state");
  return c.json(snapshot, status);
}

export type MijiaApi = Pick<
  MijiaService,
  | "homes"
  | "selectHome"
  | "getHome"
  | "getDeviceSpec"
  | "snapshot"
  | "startLogin"
  | "cancelLogin"
  | "verifyLogin"
  | "requestConnection"
  | "logout"
  | "loadDevices"
  | "reservePlayback"
  | "playbackSnapshot"
  | "offer"
  | "release"
>;

export function createMijiaRoutes(port: number, service: MijiaApi) {
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
    .get("/state", (c) => {
      return stateResponse(c, service.snapshot());
    })
    .get("/homes", (c) =>
      c.json(mijiaHomeSelectionSchema.parse(service.homes())),
    )
    .put(
      "/home-selection",
      validateJson(mijiaHomeSelectionInputSchema),
      async (c) => {
        const { accountId, homeId } = c.req.valid("json");
        return stateResponse(c, await service.selectHome(accountId, homeId));
      },
    )
    .get("/home", async (c) =>
      c.json({
        code: 0,
        message: "Home info retrieved successfully",
        data: mijiaHomeSchema.parse(await service.getHome(c.req.raw.signal)),
      }),
    )
    .get("/devices/:did/spec", async (c) =>
      c.json({
        code: 0,
        message: "ok",
        data: mijiaDeviceSpecSchema.parse(
          await service.getDeviceSpec(c.req.param("did"), c.req.raw.signal),
        ),
      }),
    )
    .post("/login", (c) => stateResponse(c, service.startLogin(), 202))
    .delete("/login/:id", (c) =>
      stateResponse(c, service.cancelLogin(c.req.param("id"))),
    )
    .post(
      "/login/:id/verify",
      validateJson(mijiaVerificationInputSchema),
      async (c) => {
        const input = c.req.valid("json");
        return stateResponse(
          c,
          await service.verifyLogin(c.req.param("id"), input.ticket),
        );
      },
    )
    .post("/connection/retry", (c) =>
      stateResponse(c, service.requestConnection(), 202),
    )
    .delete("/session", async (c) => stateResponse(c, await service.logout()))
    .post("/devices/refresh", async (c) => {
      return stateResponse(c, await service.loadDevices());
    })
    .post(
      "/playback/reservations",
      validateJson(mijiaPlaybackReservationInputSchema),
      async (c) => {
        const input = c.req.valid("json");
        const reservation = service.reservePlayback(
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
