import type { z } from "zod";
import pTimeout from "p-timeout";
import {
  agentContextPolicy,
  agentMaterialResponseSchema,
  type agentMaterialQuerySchema,
} from "@home-agent/api/agent-context";
import { AppError } from "@home-agent/api/errors";
import { accessHousehold } from "../household/access";
import { HouseholdError } from "../household/errors";
import { jsonBytes } from "../household/config";
import type { HouseholdRuntime } from "../household/runtime";
import type { createMemberActivityRepository } from "../household/identity/activity-repository";
import type { createPerceptionService } from "../perception/service";

export function createAgentMaterialReader(
  household: HouseholdRuntime,
  sightings: ReturnType<typeof createMemberActivityRepository> | undefined,
  perception: Pick<ReturnType<typeof createPerceptionService>, "readWindow">,
  shutdown: AbortSignal,
  timeoutMs: number,
) {
  return async (
    input: z.infer<typeof agentMaterialQuerySchema>,
    requestSignal: AbortSignal,
  ) => {
    const access = accessHousehold(household, input.scope.scope_epoch);
    if (
      access.identity.accountId !== input.scope.account_id ||
      access.identity.homeId !== input.scope.home_id
    )
      throw new HouseholdError("stale_session");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([requestSignal, shutdown, timeout]);
    const assertCurrent = () => {
      if (signal.aborted)
        throw new AppError(
          signal.reason instanceof DOMException &&
            signal.reason.name === "TimeoutError"
            ? "agent_timeout"
            : "request_cancelled",
        );
      access.assertCurrent();
    };
    assertCurrent();
    if (input.kind === "member_sighting" && !sightings)
      throw new HouseholdError("home_storage");
    const run = async () =>
      input.kind === "member_sighting"
        ? {
            scope: input.scope,
            kind: input.kind,
            record: await sightings!.byId(
              access.identity,
              assertCurrent,
              input.id,
            ),
          }
        : {
            scope: input.scope,
            kind: input.kind,
            window: await perception.readWindow(input.id, signal),
          };
    const result = await pTimeout(run(), {
      milliseconds: Number.POSITIVE_INFINITY,
      signal,
    }).catch((cause: unknown) => {
      assertCurrent();
      throw cause;
    });
    assertCurrent();
    if (result.kind === "member_sighting" ? !result.record : !result.window)
      throw new AppError("not_found");
    const response = agentMaterialResponseSchema.parse(result);
    if (jsonBytes(response) > agentContextPolicy.historyResponseBytes)
      throw new HouseholdError("capacity_exceeded");
    return response;
  };
}
