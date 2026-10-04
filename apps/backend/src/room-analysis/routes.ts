import { Hono } from "hono";
import {
  errorResponse,
  handleHttpError,
  validateJson,
} from "@home-agent/api/errors/hono";
import { AppError } from "@home-agent/api/errors";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { bodyLimit } from "hono/body-limit";
import { roomAnalysisQuerySchema } from "@home-agent/api/room-analysis";
import type { RoomAnalysisService } from "./service";
import { HouseholdError } from "../household/errors";
import { safeMijiaError } from "../mijia/errors";
import { createRoomAnalysisStream } from "./stream";

export function createRoomAnalysisRoutes(
  port: number,
  service: RoomAnalysisService,
) {
  const app = new Hono();
  const events = createRoomAnalysisStream(service);
  app.use(requireLocalAccess([port, 5173], { webEntry: true }));
  app.use(
    bodyLimit({
      maxSize: 1024,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
  );
  app.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) =>
    handleHttpError(
      error instanceof HouseholdError ? safeMijiaError(error) : error,
      c,
    ),
  );
  return app
    .post("/events", validateJson(roomAnalysisQuerySchema), (c) =>
      events(c, c.req.valid("json")),
    )
    .post("/query", validateJson(roomAnalysisQuerySchema), (c) =>
      c.json(service.snapshot(c.req.valid("json"))),
    )
    .post("/run", validateJson(roomAnalysisQuerySchema), (c) =>
      c.json(service.request(c.req.valid("json")), 202),
    );
}
