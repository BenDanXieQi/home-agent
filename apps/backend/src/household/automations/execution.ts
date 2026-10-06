import type {
  automations,
  automationRuns,
  automationActions,
} from "../../db/schema";

/** Freeze one admitted trigger and the actions selected for this execution. */
export function createAutomationExecution(
  automation: typeof automations.$inferSelect,
  input: typeof automationRuns.$inferSelect.input,
  evaluation: typeof automationRuns.$inferSelect.evaluation,
  timing: typeof automationRuns.$inferSelect.timing,
  id: string = crypto.randomUUID(),
  selectedActions = automation.definition.actions,
) {
  const run: Omit<typeof automationRuns.$inferSelect, "createdAt"> = {
    id,
    automationId: automation.id,
    revision: automation.revision,
    input,
    evaluation,
    timing,
    status: "pending",
    reason: null,
    expiresAt: new Date(
      Date.parse(input.at) + automation.definition.action_ttl_seconds * 1000,
    ),
  };
  const actions = selectedActions.map((action) => {
    const row: typeof automationActions.$inferSelect = {
      id: crypto.randomUUID(),
      runId: id,
      action,
      status: "pending",
      reason: null,
      timing: { queued_at: new Date().toISOString() },
      updatedAt: new Date(),
    };
    return row;
  });
  return { definition: automation.definition, run, actions };
}

export function summarizeAutomationActions(
  actions: ReturnType<typeof createAutomationExecution>["actions"],
) {
  const statuses = actions.map((action) => action.status);
  const status = statuses.includes("unknown")
    ? "unknown"
    : statuses.includes("rejected") || statuses.includes("failed")
      ? "failed"
      : statuses.includes("cancelled")
        ? "cancelled"
        : statuses.includes("accepted")
          ? "accepted"
          : "succeeded";
  return {
    status,
    reason: actions.find((action) => action.reason)?.reason ?? null,
  };
}
