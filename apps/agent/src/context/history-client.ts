import { z } from "zod";
import {
  agentHistoryQuerySchema,
  agentHistoryResponseSchema,
  agentContextPolicy,
} from "@home-agent/api/agent-context";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import type { createContextReceiver } from "./receiver";

type WithoutScope<Input> = Input extends unknown
  ? Omit<Input, "account_id" | "home_id">
  : never;

/** History is qualified by the receiver's current connection and household. */
export function createHistoryClient(options: {
  backendUrl: string;
  receiver: Pick<ReturnType<typeof createContextReceiver>, "qualification">;
}) {
  const base = z.url({ protocol: /^https?$/ }).parse(options.backendUrl);
  return async (
    query: WithoutScope<z.input<typeof agentHistoryQuerySchema>>,
    callerSignal: AbortSignal,
  ) => {
    const qualification = options.receiver.qualification();
    if (!qualification)
      throw new Error("Received household context is not synchronized");
    const scope = qualification.scope;
    const input = agentHistoryQuerySchema.parse({
      ...query,
      account_id: scope.account_id,
      home_id: scope.home_id,
    });
    const signal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(agentContextPolicy.historyTimeoutMs),
    ]);
    const response = await fetch(new URL("/api/agent/context/history", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    const body = await readLimitedJson(
      response,
      agentContextPolicy.historyResponseBytes,
      signal,
    );
    if (!response.ok)
      throw new Error(`History request failed (${response.status})`);
    const result = agentHistoryResponseSchema.parse(body);
    signal.throwIfAborted();
    const current = options.receiver.qualification();
    if (
      !current ||
      current.generation !== qualification.generation ||
      current.scope.scope_epoch !== scope.scope_epoch ||
      current.scope.account_id !== scope.account_id ||
      current.scope.home_id !== scope.home_id ||
      result.kind !== input.kind ||
      result.account_id !== scope.account_id ||
      result.home_id !== scope.home_id ||
      result.start !== input.start ||
      result.end !== input.end
    )
      throw new Error("History response qualification changed");
    return result;
  };
}
