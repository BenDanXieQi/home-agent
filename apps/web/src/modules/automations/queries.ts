import { agentWorkflowResultSchema } from "@home-agent/api/agent-workflows";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  automationCapabilitiesSchema,
  automationEvaluationSchema,
  automationRunSchema,
  automationSchema,
  type automationDeleteRequestSchema,
  type automationEvaluateRequestSchema,
  type automationGenerateRequestSchema,
  type automationSaveRequestSchema,
} from "@home-agent/api/automations";
import { requestEmpty, requestJson } from "../../api/client";

const listSchema = z.object({ automations: z.array(automationSchema) });
const runsSchema = z.object({ runs: z.array(automationRunSchema) });

export function automationListOptions(scope: string) {
  return queryOptions({
    queryKey: ["automations", scope],
    queryFn: ({ signal }) =>
      requestJson(
        (api, options) =>
          api.api.household.automations.list.$post(
            { json: { scope_epoch: scope } },
            options,
          ),
        listSchema,
        { signal },
      ),
    retry: false,
    gcTime: 0,
    refetchInterval: 10_000,
  });
}

export function automationCapabilitiesOptions(scope: string) {
  return queryOptions({
    queryKey: ["automation-capabilities", scope],
    queryFn: ({ signal }) =>
      requestJson(
        (api, options) =>
          api.api.household.automations.capabilities.$post(
            { json: { scope_epoch: scope } },
            options,
          ),
        automationCapabilitiesSchema,
        { signal },
      ),
    retry: false,
    gcTime: 0,
  });
}

export function automationRunsOptions(scope: string, id: string) {
  return queryOptions({
    queryKey: ["automation-runs", scope, id],
    queryFn: ({ signal }) =>
      requestJson(
        (api, options) =>
          api.api.household.automations.runs.$post(
            { json: { scope_epoch: scope, automation_id: id, limit: 50 } },
            options,
          ),
        runsSchema,
        { signal },
      ),
    retry: false,
    gcTime: 0,
    refetchInterval: 1000,
  });
}

export function saveAutomation(
  input: ReturnType<typeof automationSaveRequestSchema.parse>,
) {
  return requestJson(
    (api, options) =>
      api.api.household.automations.save.$post({ json: input }, options),
    automationSchema,
  );
}

export function deleteAutomation(
  input: ReturnType<typeof automationDeleteRequestSchema.parse>,
) {
  return requestEmpty((api, options) =>
    api.api.household.automations.delete.$post({ json: input }, options),
  );
}

export function evaluateAutomation(
  input: ReturnType<typeof automationEvaluateRequestSchema.parse>,
) {
  return requestJson(
    (api, options) =>
      api.api.household.automations.evaluate.$post({ json: input }, options),
    automationEvaluationSchema,
  );
}

export async function generateAutomation(
  input: ReturnType<typeof automationGenerateRequestSchema.parse>,
) {
  const { scope_epoch, ...request } = input;
  const response = await requestJson(
    (api, options) =>
      api.api.workflows.$post(
        {
          json: {
            scope_epoch,
            workflow: "automation-generation",
            input: request,
          },
        },
        options,
      ),
    agentWorkflowResultSchema,
    { timeoutMs: 120_000 },
  );
  return response.result;
}
