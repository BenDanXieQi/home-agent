import { z } from "zod";
import {
  agentHistoryQuerySchema,
  agentHistoryResponseSchema,
} from "@home-agent/api/agent-context";
import { deviceHistoryPolicy } from "@home-agent/api/device-history";
import { readLimitedJson } from "@home-agent/api/http/read-body";

const scopeSchema = z.object({
  account_id: agentHistoryQuerySchema.shape.account_id,
  home_id: agentHistoryQuerySchema.shape.home_id,
  scope_epoch: z.uuid(),
});
/** The caller owns the received binding and its runtime qualification. */
export function createHistoryClient(options: {
  backendUrl: string;
  timeoutMs: number;
  currentScope: () => z.infer<typeof scopeSchema> | null;
}) {
  const base = z.url({ protocol: /^https?$/ }).parse(options.backendUrl);
  return async (
    query: Omit<
      z.input<typeof agentHistoryQuerySchema>,
      "account_id" | "home_id"
    >,
    callerSignal: AbortSignal,
  ) => {
    const scope = scopeSchema.parse(options.currentScope());
    const input = agentHistoryQuerySchema.parse({
      ...query,
      account_id: scope.account_id,
      home_id: scope.home_id,
    });
    const signal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(options.timeoutMs),
    ]);
    const response = await fetch(new URL("/api/agent/context/history", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    const body = await readLimitedJson(
      response,
      deviceHistoryPolicy.responseBytes,
      signal,
    );
    if (!response.ok)
      throw new Error(`History request failed (${response.status})`);
    const result = agentHistoryResponseSchema.parse(body);
    signal.throwIfAborted();
    const current = options.currentScope();
    if (
      !current ||
      current.scope_epoch !== scope.scope_epoch ||
      current.account_id !== scope.account_id ||
      current.home_id !== scope.home_id ||
      result.account_id !== scope.account_id ||
      result.home_id !== scope.home_id ||
      result.start !== input.start ||
      result.end !== input.end ||
      result.representation !== input.representation
    )
      throw new Error("History response qualification changed");
    return result;
  };
}
