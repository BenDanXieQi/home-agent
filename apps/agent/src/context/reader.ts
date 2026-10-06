import { z } from "zod";
import type { BackendClient } from "@home-agent/backend-client";
import {
  agentContextPolicy,
  agentHistoryQuerySchema,
  agentHistoryResponseSchema,
  agentMaterialQuerySchema,
  agentMaterialResponseSchema,
} from "@home-agent/api/agent-context";
import { AppError } from "@home-agent/api/errors";
import { requestJson } from "@home-agent/api/http/request-json";
import type { createContextReceiver } from "./receiver";

type WithoutScope<Input> = Input extends unknown
  ? Omit<Input, "account_id" | "home_id">
  : never;

/** Reads materials belonging to the currently synchronized context, without updating it. */
export function createContextReader(options: {
  client: BackendClient;
  receiver: Pick<ReturnType<typeof createContextReceiver>, "qualification">;
}) {
  const api = options.client.api.agent.context;
  type Scope = NonNullable<
    ReturnType<typeof options.receiver.qualification>
  >["scope"];

  async function withinContext<T>(
    signal: AbortSignal,
    read: (scope: Scope) => Promise<T>,
  ) {
    const qualification = options.receiver.qualification();
    if (!qualification) throw new AppError("household_unavailable");
    const scope = qualification.scope;
    const result = await read(scope);
    signal.throwIfAborted();
    const current = options.receiver.qualification();
    if (
      !current ||
      current.generation !== qualification.generation ||
      current.scope.scope_epoch !== scope.scope_epoch ||
      current.scope.account_id !== scope.account_id ||
      current.scope.home_id !== scope.home_id
    )
      throw new AppError("household_scope_changed");
    return result;
  }

  const policy = {
    timeoutMs: agentContextPolicy.historyTimeoutMs,
    maxBytes: agentContextPolicy.historyResponseBytes,
    unavailableCode: "household_unavailable" as const,
  };
  return {
    readHistory(
      query: WithoutScope<z.input<typeof agentHistoryQuerySchema>>,
      signal: AbortSignal,
    ) {
      return withinContext(signal, async (scope) => {
        const input = agentHistoryQuerySchema.parse({
          ...query,
          account_id: scope.account_id,
          home_id: scope.home_id,
        });
        const result = await requestJson(
          (requestSignal) =>
            api.history.$post(
              { json: input },
              { init: { signal: requestSignal } },
            ),
          agentHistoryResponseSchema,
          { ...policy, signal },
        );
        if (
          result.kind !== input.kind ||
          result.account_id !== input.account_id ||
          result.home_id !== input.home_id ||
          result.start !== input.start ||
          result.end !== input.end
        )
          throw new AppError("household_scope_changed");
        return result;
      });
    },
    readMaterial(
      reference: Omit<z.input<typeof agentMaterialQuerySchema>, "scope">,
      signal: AbortSignal,
    ) {
      return withinContext(signal, async (scope) => {
        const input = agentMaterialQuerySchema.parse({ ...reference, scope });
        const result = await requestJson(
          (requestSignal) =>
            api.material.$post(
              { json: input },
              { init: { signal: requestSignal } },
            ),
          agentMaterialResponseSchema,
          { ...policy, signal },
        );
        if (
          result.scope.scope_epoch !== input.scope.scope_epoch ||
          result.scope.account_id !== input.scope.account_id ||
          result.scope.home_id !== input.scope.home_id ||
          result.kind !== input.kind ||
          (result.kind === "member_sighting"
            ? result.record.id
            : result.window.id) !== input.id
        )
          throw new AppError("household_scope_changed");
        return result;
      });
    },
  };
}
