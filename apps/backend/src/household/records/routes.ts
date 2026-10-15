import type { createStoredRecordAccess } from "./access";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@home-agent/api/errors";
import {
  errorResponse,
  handleHttpError,
  validateJson,
} from "@home-agent/api/errors/hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import {
  provenanceQuerySchema,
  commandQuerySchema,
  provenanceReadSchema,
  deviceHistoryCollectionSchema,
} from "@home-agent/api/action-provenance";
import { HouseholdError } from "../errors";
import { householdPublicError } from "../public-errors";
import type { createDeviceOperations } from "../operations/service";
import type { createCommandRepository } from "../operations/repository";
import type { createMaterialRepository } from "../materials/repository";
import type { MaterialCollection } from "../materials/collection";

export function createProvenanceRoutes(
  port: number,
  provenance:
    | {
        access: ReturnType<typeof createStoredRecordAccess>;
        operations: Pick<
          ReturnType<typeof createDeviceOperations>,
          "diagnostics"
        >;
        commands: Pick<
          ReturnType<typeof createCommandRepository>,
          "queryCommands" | "readCommand"
        >;
        materials: Pick<
          ReturnType<typeof createMaterialRepository>,
          "query" | "read"
        >;
        collectors: MaterialCollection;
      }
    | undefined,
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
  app.onError((error, c) =>
    handleHttpError(
      error instanceof HouseholdError ? householdPublicError(error) : error,
      c,
    ),
  );
  function requireStorage() {
    if (!provenance) throw new HouseholdError("home_storage");
    return provenance;
  }
  return app
    .post("/commands/query", validateJson(commandQuerySchema), async (c) => {
      const input = c.req.valid("json");
      return c.json(
        await requireStorage().commands.queryCommands(
          await requireStorage().access(input.scope_epoch, c.req.raw.signal),
          input,
        ),
      );
    })
    .post("/commands/read", validateJson(provenanceReadSchema), async (c) => {
      const input = c.req.valid("json");
      return c.json({
        record: await requireStorage().commands.readCommand(
          await requireStorage().access(input.scope_epoch, c.req.raw.signal),
          input.id,
        ),
      });
    })
    .post(
      "/materials/query",
      validateJson(provenanceQuerySchema),
      async (c) => {
        const input = c.req.valid("json");
        return c.json(
          await requireStorage().materials.query(
            await requireStorage().access(input.scope_epoch, c.req.raw.signal),
            input,
          ),
        );
      },
    )
    .post("/materials/read", validateJson(provenanceReadSchema), async (c) => {
      const input = c.req.valid("json");
      return c.json({
        record: await requireStorage().materials.read(
          await requireStorage().access(input.scope_epoch, c.req.raw.signal),
          input.id,
        ),
      });
    })
    .post(
      "/materials/collect-device-history",
      validateJson(deviceHistoryCollectionSchema),
      async (c) =>
        c.json(
          await requireStorage().collectors.collectDeviceHistory(
            c.req.valid("json"),
          ),
        ),
    )
    .get("/diagnostics", (c) =>
      c.json({
        ...requireStorage().collectors.diagnostics(),
        commands: requireStorage().operations.diagnostics(),
      }),
    );
}
