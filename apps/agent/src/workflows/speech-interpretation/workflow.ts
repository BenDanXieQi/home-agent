import { z } from "zod";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { speechObservationSchema } from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import { defineWorkflow, type WorkflowDependencies } from "../definition";
import { optionalModelRefSchema } from "../../models";

export const speechDialogueLimits = Object.freeze({
  contextSegments: 3,
  lifetimeMs: 45000,
});
const assistantNamesSchema = z
  .array(z.string().trim().min(1).max(32))
  .min(1)
  .max(8);

export const speechDecisionSchema = z
  .object({
    needsResponse: z.boolean(),
    isComplete: z.boolean(),
    category: z.enum([
      "assistant_request",
      "conversation",
      "media",
      "uncertain",
    ]),
    requestText: z.string().trim().min(1).nullable(),
    reason: z.string().min(1),
  })
  .refine(
    (decision) =>
      decision.needsResponse === (decision.category === "assistant_request") &&
      (decision.requestText !== null) ===
        (decision.needsResponse && decision.isComplete),
    "Inconsistent speech interpretation",
  );

export const speechDialogueRequestSchema = z.object({
  id: z.uuid(),
  expiresAt: z.number(),
  assistantNames: assistantNamesSchema,
  current: speechObservationSchema,
  preceding: z
    .array(speechObservationSchema)
    .max(speechDialogueLimits.contextSegments),
});

export function validSpeechDialogueRequest(
  input: z.infer<typeof speechDialogueRequestSchema>,
  now: number,
) {
  const current = input.current;
  const withinLifetime =
    input.expiresAt > now &&
    input.expiresAt <=
      current.observedEndAt + speechDialogueLimits.lifetimeMs &&
    current.observedEndAt <= now + 2000;
  if (!withinLifetime) return false;
  if (!current.text.trim()) return false;

  const observationIds = [
    current.id,
    ...input.preceding.map((item) => item.id),
  ];
  if (new Set(observationIds).size !== observationIds.length) return false;

  return input.preceding.every(
    (item) =>
      item.run.trackRunId === current.run.trackRunId &&
      item.run.deviceId === current.run.deviceId &&
      item.generation === current.generation &&
      item.endSample <= current.startSample &&
      now - item.observedEndAt < speechDialogueLimits.lifetimeMs,
  );
}

export const speechDialogueResponseSchema = z.object({
  id: z.uuid(),
  observationId: speechObservationSchema.shape.id,
  decision: speechDecisionSchema,
});

export const contract = {
  input: speechDialogueRequestSchema,
  progress: z.never(),
  result: speechDialogueResponseSchema,
};

export const extensions = [] as const;

export const modelConfiguration = {
  key: "AGENT_SPEECH_MODEL",
  schema: optionalModelRefSchema,
} as const;

export const observation = {
  start: (input: z.infer<typeof speechDialogueRequestSchema>) => ({
    attributes: { "speech.request.id": input.id },
  }),
};

export function createWorkflow(context: Parameters<typeof defineWorkflow>[1]) {
  return defineWorkflow(createSpeechInterpretationWorkflow, context);
}

function createSpeechInterpretationWorkflow({
  model,
  modelCollection,
  prompts,
}: WorkflowDependencies) {
  async function interpretSpeech(
    input: z.infer<typeof speechDialogueRequestSchema>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();

    const response = await prompts.complete(
      {
        name: "speech-interpretation",
        userVariables: {
          input: JSON.stringify(formatSpeechForModel(input)),
        },
        model,
        modelCollection,
        tools: [
          {
            name: "interpret_speech",
            parameters: z.toJSONSchema(speechDecisionSchema),
            constrainedSampling: {
              type: "json_schema",
              strict: "require",
            },
          },
        ],
      },
      withAbortSignal(signal, BACKGROUND_CONTEXT),
    );

    signal.throwIfAborted();

    const calls = response.content.filter((block) => block.type === "toolCall");
    const [call] = calls;
    if (
      !["stop", "toolUse"].includes(response.stopReason) ||
      calls.length !== 1 ||
      call?.name !== "interpret_speech"
    )
      throw new Error(
        response.errorMessage ?? "Incomplete speech interpretation",
      );

    const decision = speechDecisionSchema.parse(call.arguments);

    const result = {
      id: input.id,
      observationId: input.current.id,
      decision,
    } satisfies z.infer<typeof speechDialogueResponseSchema>;

    return result;
  }

  async function run(
    input: Parameters<typeof interpretSpeech>[0],
    requestSignal: AbortSignal,
  ) {
    requestSignal.throwIfAborted();
    if (!validSpeechDialogueRequest(input, Date.now()))
      throw new AppError("invalid_request");

    const signal = AbortSignal.any([
      requestSignal,
      AbortSignal.timeout(
        Math.max(1, Math.floor(input.expiresAt - Date.now())),
      ),
    ]);

    return interpretSpeech(input, signal);
  }

  return { run };
}

function formatSpeechForModel(
  input: z.infer<typeof speechDialogueRequestSchema>,
) {
  const segmentContext = (segment: typeof input.current) => ({
    text: segment.text,
    boundary: segment.boundary,
    startOffsetMs: Math.round(
      segment.observedStartAt - input.current.observedStartAt,
    ),
    endOffsetMs: Math.round(
      segment.observedEndAt - input.current.observedStartAt,
    ),
  });

  return {
    assistantNames: input.assistantNames,
    current: segmentContext(input.current),
    preceding: input.preceding
      .toSorted((a, b) => a.startSample - b.startSample)
      .map(segmentContext),
  };
}
