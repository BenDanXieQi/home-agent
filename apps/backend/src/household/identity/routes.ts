import { ImageProcessingError } from "../../perception/detection/image-request";
import { ReferenceEnrollmentError } from "./errors";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import {
  referenceMemberSchema,
  referenceSavedSchema,
  referenceCancelledSchema,
  referenceDeleteSchema,
  referenceToggleSchema,
  referenceRecordingSchema,
  identityEnrollmentLimits,
  imageLimits,
  referenceSessionSchema,
  referenceConfirmSchema,
} from "@home-agent/api/contracts";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { AppError, validationIssues } from "@home-agent/api/errors";
import { z } from "zod";
import { DetectionPoolError } from "../../perception/compute/pool";
import {
  validateJson,
  handleHttpError,
  errorResponse,
} from "@home-agent/api/errors/hono";
import { createBoundedMediaUpload } from "../../media/upload";
import type { createReferenceEnrollment } from "./enrollment";
import type { createIdentityReferences } from "./references";
import type { HouseholdRuntime } from "../runtime";
import { createMemberAccess } from "../members/access";
import { HouseholdError } from "../errors";
import { householdPublicError } from "../public-errors";

function parse<S extends z.ZodType>(schema: S, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError("invalid_request", {
      issues: validationIssues(result.error),
    });
  return result.data;
}
function wireError(error: unknown) {
  if (error instanceof ImageProcessingError)
    return new AppError("perception_image_invalid", { cause: error });
  if (error instanceof ReferenceEnrollmentError) {
    const codes = {
      busy: "perception_busy",
      model_unavailable: "perception_unavailable",
      enrollment_unavailable: "identity_enrollment_unavailable",
      source_unavailable: "identity_source_unavailable",
      invalid_recording: "identity_recording_invalid",
    } as const;
    return new AppError(codes[error.reason], { cause: error });
  }
  if (error instanceof HouseholdError)
    return error.reason === "invalid_state"
      ? new AppError("identity_reference_unavailable", { cause: error })
      : householdPublicError(error);
  if (error instanceof DetectionPoolError)
    return new AppError(
      error.code === "busy"
        ? "perception_busy"
        : error.code === "invalid_image"
          ? "perception_image_invalid"
          : error.code === "timeout"
            ? "perception_timeout"
            : "perception_unavailable",
      { cause: error },
    );
  return error instanceof Error
    ? error
    : new Error("Reference operation failed", { cause: error });
}

export function createIdentityRoutes(options: {
  port: number;
  household: HouseholdRuntime;
  shutdown: AbortSignal;
  timeoutMs: number;
  enrollment: ReturnType<typeof createReferenceEnrollment> | undefined;
  references: ReturnType<typeof createIdentityReferences> | undefined;
}) {
  const access = createMemberAccess(options.household);
  function services() {
    if (!options.enrollment || !options.references)
      throw new HouseholdError("home_storage");
    return { enrollment: options.enrollment, references: options.references };
  }
  const upload = createBoundedMediaUpload(
    (files, signal, request) =>
      services()
        .enrollment.upload(
          referenceSessionSchema.parse(
            Object.fromEntries(new URL(request.url).searchParams),
          ),
          files,
          signal,
        )
        .catch((error) => {
          throw wireError(error);
        }),
    options.shutdown,
    Math.min(options.timeoutMs, identityEnrollmentLimits.extractionMs),
    {
      maxBytes: identityEnrollmentLimits.uploadBytes + 64 * 1024,
      invalidCode: "perception_image_invalid",
      multipart: {
        maxFiles: identityEnrollmentLimits.candidates,
        maxFileBytes: imageLimits.maxFileBytes,
        maxTotalBytes: identityEnrollmentLimits.uploadBytes,
      },
    },
  );
  const recordingQuery = referenceRecordingSchema.extend({
    channel: z
      .enum(["1", "2"])
      .transform((value) => (value === "1" ? (1 as const) : (2 as const))),
  });
  const recording = createBoundedMediaUpload(
    ([file], signal, request) =>
      services()
        .enrollment.recording(
          recordingQuery.parse(
            Object.fromEntries(new URL(request.url).searchParams),
          ),
          file!.path,
          signal,
        )
        .catch((error) => {
          throw wireError(error);
        }),
    options.shutdown,
    Math.min(options.timeoutMs, identityEnrollmentLimits.extractionMs),
    {
      maxBytes: identityEnrollmentLimits.recordingBytes,
      invalidCode: "identity_recording_invalid",
    },
  );
  let extracting:
    | {
        input: z.infer<typeof referenceSessionSchema>;
        controller: AbortController;
        finished: Promise<void>;
      }
    | undefined;
  async function receiveUpload(
    input: z.infer<typeof referenceSessionSchema>,
    request: Request,
    receive: typeof upload,
  ) {
    if (extracting) throw new ReferenceEnrollmentError("busy");
    const completion = Promise.withResolvers<void>();
    const selected = {
      input,
      controller: new AbortController(),
      finished: completion.promise,
    };
    extracting = selected;
    try {
      return await receive(
        new Request(request, {
          signal: AbortSignal.any([request.signal, selected.controller.signal]),
        }),
      );
    } catch (cause) {
      options.enrollment?.cancel(input);
      throw cause;
    } finally {
      if (extracting === selected) extracting = undefined;
      completion.resolve();
    }
  }
  const app = new Hono()
    .use(requireLocalAccess([options.port, 5173], { webEntry: true }))
    .use(async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    });
  app.onError((error, c) => handleHttpError(wireError(error), c));
  return app
    .post(
      "/upload",
      validator("query", (value) => parse(referenceSessionSchema, value)),
      async (c) =>
        c.json(await receiveUpload(c.req.valid("query"), c.req.raw, upload)),
    )
    .post(
      "/recording",
      validator("query", (value) => parse(recordingQuery, value)),
      async (c) =>
        c.json(await receiveUpload(c.req.valid("query"), c.req.raw, recording)),
    )
    .get(
      "/image/:sampleId",
      validator("param", (value) =>
        parse(referenceDeleteSchema.pick({ sampleId: true }), value),
      ),
      validator("query", (value) => parse(referenceMemberSchema, value)),
      async (c) => {
        const input = c.req.valid("query");
        const context = access(input.scope_epoch);
        const result = await services().references.readImage(
          context.identity,
          context.assertCurrent,
          input.memberId,
          c.req.valid("param").sampleId,
        );
        return c.body(result.bytes, 200, {
          "Content-Type": result.contentType,
        });
      },
    )
    .use(
      bodyLimit({
        maxSize: 16 * 1024,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
    )
    .post("/list", validateJson(referenceMemberSchema), async (c) =>
      c.json(await services().enrollment.list(c.req.valid("json"))),
    )
    .post("/preview", validateJson(referenceSessionSchema), async (c) =>
      c.json(await services().enrollment.poll(c.req.valid("json"))),
    )
    .post("/cancel", validateJson(referenceSessionSchema), async (c) => {
      const input = c.req.valid("json");
      const selected = extracting;
      if (
        selected?.input.sessionId === input.sessionId &&
        selected.input.memberId === input.memberId &&
        selected.input.scope_epoch === input.scope_epoch
      ) {
        selected.controller.abort();
        await selected.finished;
      }
      return c.json(
        referenceCancelledSchema.parse(services().enrollment.cancel(input)),
      );
    })
    .post("/confirm", validateJson(referenceConfirmSchema), async (c) =>
      c.json(
        referenceSavedSchema.parse(
          await services().enrollment.confirm(c.req.valid("json")),
        ),
      ),
    )
    .post("/delete", validateJson(referenceDeleteSchema), async (c) => {
      const input = c.req.valid("json");
      const context = access(input.scope_epoch);
      await services().references.remove(
        context.identity,
        context.assertCurrent,
        input.memberId,
        input.sampleId,
      );
      return c.json(await services().enrollment.list(input));
    })
    .post("/toggle", validateJson(referenceToggleSchema), async (c) => {
      const input = c.req.valid("json");
      const context = access(input.scope_epoch);
      await services().references.matching.toggle(
        context.identity,
        context.assertCurrent,
        input.memberId,
        input.enabled,
      );
      return c.json(await services().enrollment.list(input));
    });
}
