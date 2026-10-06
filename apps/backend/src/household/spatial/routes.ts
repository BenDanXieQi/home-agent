import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { AppError } from "@home-agent/api/errors";
import {
  errorResponse,
  handleHttpError,
  validateJson,
} from "@home-agent/api/errors/hono";
import {
  observationBindingEnabledSchema,
  spatialReadSchema,
  spaceSaveSchema,
  passageSaveSchema,
  observationBindingSaveSchema,
  spatialDeleteSchema,
} from "@home-agent/api/spatial";
import { SpatialError } from "./errors";
import type { createSpatialService } from "./service";

export function createSpatialRoutes(
  port: number,
  service: ReturnType<typeof createSpatialService>,
) {
  const app = new Hono();
  app.use(requireLocalAccess([port, 5173], { webEntry: true }));
  app.use(
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
  );
  app.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof SpatialError) {
      const code =
        error.reason === "not_found"
          ? "not_found"
          : (`spatial_${error.reason}` as const);
      return handleHttpError(new AppError(code, { cause: error }), c);
    }
    return handleHttpError(error, c);
  });
  return app
    .post("/read", validateJson(spatialReadSchema), async (c) =>
      c.json(await service.read()),
    )
    .post("/spaces/save", validateJson(spaceSaveSchema), async (c) =>
      c.json(await service.saveSpace(c.req.valid("json"))),
    )
    .post("/passages/save", validateJson(passageSaveSchema), async (c) =>
      c.json(await service.savePassage(c.req.valid("json"))),
    )
    .post(
      "/observation-bindings/save",
      validateJson(observationBindingSaveSchema),
      async (c) =>
        c.json(await service.saveObservationBinding(c.req.valid("json"))),
    )
    .post(
      "/observation-bindings/enabled",
      validateJson(observationBindingEnabledSchema),
      async (c) =>
        c.json(await service.setObservationBindingEnabled(c.req.valid("json"))),
    )
    .post("/spaces/delete", validateJson(spatialDeleteSchema), async (c) => {
      const result = await service.deleteSpace(c.req.valid("json"));
      return result.status === "referenced"
        ? c.json(result, 409)
        : c.json(result, 200);
    })
    .post("/passages/delete", validateJson(spatialDeleteSchema), async (c) => {
      const result = await service.deletePassage(c.req.valid("json"));
      return result.status === "referenced"
        ? c.json(result, 409)
        : c.json(result, 200);
    })
    .post(
      "/observation-bindings/delete",
      validateJson(spatialDeleteSchema),
      async (c) =>
        c.json(await service.deleteObservationBinding(c.req.valid("json"))),
    );
}
