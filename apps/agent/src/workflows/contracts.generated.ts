import { z } from "zod";
import { contract as contract0 } from "./automation-generation/workflow";
import { contract as contract1 } from "./spatial-planning/workflow";
import { contract as contract2 } from "./speech-interpretation/workflow";

export const agentWorkflowInputSchema = z.discriminatedUnion("workflow", [
  z.strictObject({
    workflow: z.literal("automation-generation"),
    input: contract0.input,
  }),
  z.strictObject({
    workflow: z.literal("spatial-planning"),
    input: contract1.input,
  }),
  z.strictObject({
    workflow: z.literal("speech-interpretation"),
    input: contract2.input,
  }),
]);

export const agentWorkflowStreamContracts = {
  "automation-generation": {
    progress: z.strictObject({
      workflow: z.literal("automation-generation"),
      progress: contract0.progress,
    }),
    result: z.strictObject({
      workflow: z.literal("automation-generation"),
      result: contract0.result,
    }),
  },
  "spatial-planning": {
    progress: z.strictObject({
      workflow: z.literal("spatial-planning"),
      progress: contract1.progress,
    }),
    result: z.strictObject({
      workflow: z.literal("spatial-planning"),
      result: contract1.result,
    }),
  },
  "speech-interpretation": {
    progress: z.strictObject({
      workflow: z.literal("speech-interpretation"),
      progress: contract2.progress,
    }),
    result: z.strictObject({
      workflow: z.literal("speech-interpretation"),
      result: contract2.result,
    }),
  },
};

export const agentWorkflowStreamContract = {
  progress: z.discriminatedUnion("workflow", [
    agentWorkflowStreamContracts["automation-generation"].progress,
    agentWorkflowStreamContracts["spatial-planning"].progress,
    agentWorkflowStreamContracts["speech-interpretation"].progress,
  ]),

  result: z.discriminatedUnion("workflow", [
    agentWorkflowStreamContracts["automation-generation"].result,
    agentWorkflowStreamContracts["spatial-planning"].result,
    agentWorkflowStreamContracts["speech-interpretation"].result,
  ]),
};
