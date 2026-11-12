import { z } from "zod";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { speechObservationSchema } from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import type { WorkflowDependencies } from "../definition";
import { submitConversationInput } from "../../conversation/submit";
import {
  SpeechInterpretationDoc,
  SpeechInterpretationExtension,
  speechDecisionSchema,
  speechInterpretationPromptName,
  speechInterpretationAgentName,
} from "./extension";
import type { speechDialogueRequestSchema } from "./workflow";

export const speechDialogueResponseSchema = z.object({
  id: z.uuid(),
  observationId: speechObservationSchema.shape.id,
  decision: speechDecisionSchema,
});

export async function interpretSpeech(
  { harness, model }: Pick<WorkflowDependencies, "harness" | "model">,
  input: z.infer<typeof speechDialogueRequestSchema>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();

  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  await using conversation = await harness.createConversation(
    {
      agentName: speechInterpretationAgentName,
      prompt: { name: speechInterpretationPromptName },
      ownership: { kind: "ownerless" },
      agent: {
        model: { provider: model.provider, modelId: model.id },
        extensions: [SpeechInterpretationExtension],
      },
    },
    context,
  );

  return await conversation.withTraceContext(async () => {
    await submitConversationInput(
      conversation,
      JSON.stringify(formatSpeechForModel(input)),
      signal,
    );

    return conversation.commit(async (tx) => {
      const { decision } = await tx.doc(
        SpeechInterpretationDoc,
        conversation.id,
      );
      if (!decision) throw new AppError("agent_execution_failed");

      return speechDialogueResponseSchema.parse({
        id: input.id,
        observationId: input.current.id,
        decision,
      });
    }, context);
  });
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
