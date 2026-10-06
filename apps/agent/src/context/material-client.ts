import { z } from "zod";
import {
  agentContextPolicy,
  agentMaterialQuerySchema,
  agentMaterialResponseSchema,
} from "@home-agent/api/agent-context";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import type { createContextReceiver } from "./receiver";

/** Reference resolution reads current retained source material, never changes receiver state. */
export function createMaterialClient(options: {
  backendUrl: string;
  receiver: Pick<ReturnType<typeof createContextReceiver>, "qualification">;
}) {
  const base = z.url({ protocol: /^https?$/ }).parse(options.backendUrl);
  return async (
    reference: Omit<z.input<typeof agentMaterialQuerySchema>, "scope">,
    callerSignal: AbortSignal,
  ) => {
    const qualification = options.receiver.qualification();
    if (!qualification)
      throw new Error("Received household context is not synchronized");
    const input = agentMaterialQuerySchema.parse({
      ...reference,
      scope: qualification.scope,
    });
    const signal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(agentContextPolicy.historyTimeoutMs),
    ]);
    const response = await fetch(new URL("/api/agent/context/material", base), {
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
      throw new Error(`Material request failed (${response.status})`);
    const result = agentMaterialResponseSchema.parse(body);
    signal.throwIfAborted();
    const current = options.receiver.qualification();
    if (
      !current ||
      current.generation !== qualification.generation ||
      current.scope.scope_epoch !== input.scope.scope_epoch ||
      current.scope.account_id !== input.scope.account_id ||
      current.scope.home_id !== input.scope.home_id ||
      result.scope.scope_epoch !== input.scope.scope_epoch ||
      result.scope.account_id !== input.scope.account_id ||
      result.scope.home_id !== input.scope.home_id ||
      result.kind !== input.kind ||
      (result.kind === "member_sighting"
        ? result.record.id
        : result.window.id) !== input.id
    )
      throw new Error("Material response qualification changed");
    return result;
  };
}
