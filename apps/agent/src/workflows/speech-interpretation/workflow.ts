import { z } from "zod";
import { speechObservationSchema } from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import { defineWorkflow } from "../definition";
import { optionalModelRefSchema } from "../../models";
import {
  SpeechInterpretationExtension,
  speechInterpretationAgentName,
} from "./extension";
import { interpretSpeech, speechDialogueResponseSchema } from "./session";

export { speechDecisionSchema } from "./extension";
export { speechDialogueResponseSchema } from "./session";

export const speechDialogueLimits = Object.freeze({
  contextSegments: 3,
  lifetimeMs: 45000,
});
const assistantNamesSchema = z
  .array(z.string().trim().min(1).max(32))
  .min(1)
  .max(8);

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

export const contract = {
  input: speechDialogueRequestSchema,
  progress: z.never(),
  result: speechDialogueResponseSchema,
};

export const extensions = [SpeechInterpretationExtension] as const;

export const modelConfiguration = {
  key: "AGENT_SPEECH_MODEL",
  schema: optionalModelRefSchema,
} as const;

export const observation = {
  start: (input: z.infer<typeof speechDialogueRequestSchema>) => ({
    attributes: {
      "gen_ai.agent.name": speechInterpretationAgentName,
      "speech.request.id": input.id,
    },
  }),
};

export function createWorkflow(context: Parameters<typeof defineWorkflow>[1]) {
  return defineWorkflow(createSpeechInterpretationWorkflow, context);
}

function createSpeechInterpretationWorkflow(
  dependencies: Parameters<typeof interpretSpeech>[0],
) {
  async function run(
    input: z.infer<typeof speechDialogueRequestSchema>,
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

    const result = await interpretSpeech(dependencies, input, signal);
    signal.throwIfAborted();
    return result;
  }

  return { run };
}
