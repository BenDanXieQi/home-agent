import { Hono } from "hono";
import { validator } from "hono/validator";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  mediaAnalysisCompletedSchema,
  mediaAnalysisInputSchema,
  mediaAgentHistoryQuerySchema,
} from "@home-agent/agent/media-analysis/session";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { AppError, validationIssues } from "@home-agent/api/errors";
import {
  errorResponse,
  handleHttpError,
  validateJson,
} from "@home-agent/api/errors/hono";
import type { createAgentContextService } from "../agent-context/service";
import type { createAgentClient } from "../agent-client";
import type { HouseholdRuntime } from "../household/runtime";
import { accessHousehold } from "../household/access";
import { HouseholdError } from "../household/errors";
import { householdPublicError } from "../household/public-errors";
import type { createPerceptionService } from "../perception/service";
import type { createDynamicsRepository } from "./repository";
import { readAnalysisMedia } from "./media";

const historyQuerySchema = z
  .object({
    at: z.coerce.number().finite().optional(),
    id: z.uuid().optional(),
  })
  .refine((value) => (value.at === undefined) === (value.id === undefined));

export function createDynamicsRoutes({
  port,
  household,
  agent,
  perception,
  recordings,
  executable,
  agentContext,
  repository,
}: {
  port: number;
  household: HouseholdRuntime;
  agent: ReturnType<typeof createAgentClient>;
  perception: Pick<
    ReturnType<typeof createPerceptionService>,
    "readAudioRange"
  >;
  recordings: Parameters<typeof readAnalysisMedia>[0]["recordings"];
  executable: string;
  agentContext: Pick<ReturnType<typeof createAgentContextService>, "snapshot">;
  repository: ReturnType<typeof createDynamicsRepository> | undefined;
}) {
  function requireStorage() {
    if (!repository) throw new HouseholdError("home_storage");
    return repository;
  }
  function requireRange(input: z.infer<typeof mediaAnalysisInputSchema>) {
    const observations = agentContext.snapshot().parts.observations;
    if (
      observations?.status !== "ready" ||
      !observations.data.media_ranges.some(
        (range) =>
          range.source.deviceId === input.source.deviceId &&
          range.source.channel === input.source.channel &&
          (range.kind === input.kind || input.kind === "audio") &&
          range.includeAudio === input.includeAudio &&
          range.startedAt <= input.startedAt &&
          range.endedAt >= input.endedAt &&
          range.readableUntil > Date.now(),
      )
    )
      throw new AppError("not_found");
  }
  return new Hono()
    .use(requireLocalAccess([port, 5173], { webEntry: true }))
    .use(async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .onError((error, c) =>
      handleHttpError(
        error instanceof HouseholdError ? householdPublicError(error) : error,
        c,
      ),
    )
    .get(
      "/history",
      validator("query", (value) => {
        const parsed = historyQuerySchema.safeParse(value);
        if (!parsed.success)
          throw new AppError("invalid_request", {
            issues: validationIssues(parsed.error),
          });
        return parsed.data;
      }),
      async (c) => {
        const access = accessHousehold(household, household.epoch);
        const before = c.req.valid("query");
        return c.json(
          await requireStorage().history(
            access.identity,
            () => {
              c.req.raw.signal.throwIfAborted();
              access.assertCurrent();
            },
            before.at !== undefined && before.id
              ? { at: before.at, id: before.id }
              : undefined,
          ),
        );
      },
    )
    .post(
      "/media",
      requireLocalAccess([port]),
      bodyLimit({
        maxSize: 4096,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
      validateJson(mediaAnalysisInputSchema),
      async (c) => {
        const access = accessHousehold(household, household.epoch);
        const input = c.req.valid("json");
        requireRange(input);
        const result = await readAnalysisMedia({
          input,
          scopeEpoch: household.epoch,
          recordings,
          perception,
          executable,
          signal: c.req.raw.signal,
        });
        c.req.raw.signal.throwIfAborted();
        access.assertCurrent();
        requireRange(input);
        return new Response(result.data, {
          headers: {
            "Content-Type": result.contentType,
            "Cache-Control": "no-store",
            "X-Media-Started-At": String(result.startedAt),
            "X-Media-Ended-At": String(result.endedAt),
          },
        });
      },
    )
    .post(
      "/completed",
      requireLocalAccess([port]),
      bodyLimit({
        maxSize: 1024 * 1024,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
      validateJson(mediaAnalysisCompletedSchema),
      async (c) => {
        const access = accessHousehold(household, household.epoch);
        const entry = c.req.valid("json");
        await requireStorage().save(
          access.identity,
          () => {
            c.req.raw.signal.throwIfAborted();
            access.assertCurrent();
          },
          entry,
          household.epoch,
        );
        return c.json({ saved: true as const });
      },
    )
    .get("/stream", async (c) =>
      agent.mediaAnalysis("/stream", c.req.raw.signal),
    )
    .get(
      "/agent-history",
      validator("query", (value) => {
        const parsed = mediaAgentHistoryQuerySchema.safeParse(value);
        if (!parsed.success)
          throw new AppError("invalid_request", {
            issues: validationIssues(parsed.error),
          });
        return parsed.data;
      }),
      async (c) =>
        c.json(
          await agent.mediaAgentHistory(
            c.req.valid("query").before,
            c.req.raw.signal,
          ),
        ),
    )
    .get("/:id/stream", async (c) =>
      agent.mediaAnalysis(
        `/${encodeURIComponent(c.req.param("id"))}/stream`,
        c.req.raw.signal,
      ),
    )
    .get("/:id/media/:index", async (c) =>
      agent.mediaAnalysis(
        `/${encodeURIComponent(c.req.param("id"))}/media/${encodeURIComponent(c.req.param("index"))}`,
        c.req.raw.signal,
      ),
    )
    .get("/:id", async (c) =>
      agent.mediaAnalysis(
        `/${encodeURIComponent(c.req.param("id"))}`,
        c.req.raw.signal,
      ),
    );
}
