import { z } from "zod";
import { memo as once } from "radash";
import { AppError } from "@home-agent/api/errors";
import { genAiMessages } from "@home-agent/observability";
import { optionalModelRefSchema } from "../../models";
import { defineWorkflow } from "../definition";
import { spatialLayoutSchema } from "@home-agent/api/spatial";
import {
  createSpatialPlanningSession,
  spatialPlanningResultSchema,
  spatialPlanningProgressSchema,
} from "./session";
const imageSchema = z.strictObject({
  type: z.literal("image"),
  mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data: z.base64().min(1),
});

export const spatialPlanningInputSchema = z.discriminatedUnion("action", [
  z
    .strictObject({
      action: z.literal("message"),
      session_id: z.uuid().optional(),
      draft: spatialLayoutSchema.optional(),
      text: z.string().trim(),
      images: z.array(imageSchema).default([]),
    })
    .refine((input) => input.text.length > 0 || input.images.length > 0, {
      message: "Provide text or an image.",
    })
    .refine((input) => !input.session_id || !input.draft, {
      message: "Provide a draft only when creating a session.",
    }),
  z.strictObject({ action: z.literal("close"), session_id: z.uuid() }),
]);

export const contract = {
  input: spatialPlanningInputSchema,
  progress: spatialPlanningProgressSchema,
  result: spatialPlanningResultSchema,
};

export const modelConfiguration = {
  key: "AGENT_SPATIAL_MODEL",
  schema: optionalModelRefSchema,
} as const;

export const observation = {
  start: (input: z.infer<typeof spatialPlanningInputSchema>) => {
    if (input.action !== "message") return undefined;
    return {
      attributes: {
        "home_agent.spatial.image_count": input.images.length,
        ...(input.session_id && {
          "gen_ai.conversation.id": input.session_id,
        }),
      },
      messages: () =>
        genAiMessages([
          {
            role: "user",
            content: [
              { type: "text", text: input.text },
              ...input.images.map((image) => ({
                type: "image" as const,
                data: image.data,
                mimeType: image.mime_type,
              })),
            ],
            timestamp: Date.now(),
          },
        ]),
    };
  },
  complete: (result: z.infer<typeof spatialPlanningResultSchema>) => {
    if (result.status === "closed") return {};
    return {
      attributes: {
        "gen_ai.conversation.id": result.session_id,
        "home_agent.spatial.space_count": result.draft.spaces.length,
        "home_agent.spatial.passage_count": result.draft.passages.length,
        "home_agent.spatial.question_count": result.questions.length,
      },
      messages: () => [
        {
          role: "assistant",
          parts: [{ type: "text", content: JSON.stringify(result) }],
        },
      ],
    };
  },
};

export function createWorkflow(context: Parameters<typeof defineWorkflow>[1]) {
  return defineWorkflow(createSpatialPlanningWorkflow, context);
}

function createSpatialPlanningWorkflow(
  dependencies: Parameters<typeof createSpatialPlanningSession>[0],
) {
  type PlanningSession = Awaited<
    ReturnType<typeof createSpatialPlanningSession>
  >;

  let currentSession: PlanningSession | undefined;
  const inFlightSessionChanges = new Set<Promise<unknown>>();
  let closed = false;
  let lifecycle = new AbortController();

  function trackSessionChange<T>(change: Promise<T>) {
    inFlightSessionChanges.add(change);
    return change.finally(() => {
      inFlightSessionChanges.delete(change);
    });
  }

  async function replaceCurrentSession(
    input: Parameters<PlanningSession["message"]>[0],
    signal: AbortSignal,
    receive: Parameters<PlanningSession["message"]>[2],
  ) {
    const previous = currentSession;
    currentSession = undefined;
    await previous?.dispose();
    signal.throwIfAborted();
    const session = await createSpatialPlanningSession(
      dependencies,
      input.draft,
      signal,
    );
    try {
      const snapshot = await session.message(input, signal, receive);
      signal.throwIfAborted();
      currentSession = session;
      return snapshot;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  async function handlePlanningRequest(
    input: z.infer<typeof spatialPlanningInputSchema>,
    requestSignal: AbortSignal,
    receive?: Parameters<PlanningSession["message"]>[2],
  ) {
    if (closed) throw new AppError("request_cancelled");
    requestSignal.throwIfAborted();
    lifecycle.signal.throwIfAborted();

    if (input.action === "message" && !input.session_id) {
      if (inFlightSessionChanges.size) throw new AppError("workflow_busy");
      lifecycle.abort(new AppError("request_cancelled"));
      lifecycle = new AbortController();
      const signal = AbortSignal.any([requestSignal, lifecycle.signal]);
      return trackSessionChange(replaceCurrentSession(input, signal, receive));
    }

    const session = currentSession;
    if (!session || session.sessionId !== input.session_id)
      throw new AppError("not_found");
    const signal = AbortSignal.any([requestSignal, lifecycle.signal]);

    switch (input.action) {
      case "message":
        return session.message(input, signal, receive);
      case "close":
        currentSession = undefined;
        return trackSessionChange(session.close(signal));
    }
  }

  async function reset() {
    lifecycle.abort(new AppError("request_cancelled"));
    const session = currentSession;
    currentSession = undefined;

    const disposing = session?.dispose() ?? Promise.resolve();
    const draining = Promise.all([
      Promise.allSettled(inFlightSessionChanges),
      disposing,
    ]);
    await trackSessionChange(draining);
    if (!closed) lifecycle = new AbortController();
  }

  const close = once(async () => {
    closed = true;
    lifecycle.abort(new AppError("request_cancelled"));

    await Promise.allSettled(inFlightSessionChanges);
    const session = currentSession;
    currentSession = undefined;
    await session?.dispose();
  });

  return { run: handlePlanningRequest, reset, close };
}
