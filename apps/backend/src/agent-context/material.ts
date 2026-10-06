import type { z } from "zod";
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
  perception: ReturnType<typeof createPerceptionService>,
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
          timeout.aborted ? "agent_timeout" : "request_cancelled",
        );
      access.assertCurrent();
    };
    assertCurrent();
    if (input.kind === "member_sighting" && !sightings)
      throw new HouseholdError("home_storage");
    const result =
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
            window: perception.window(input.id),
          };
    assertCurrent();
    if (result.kind === "member_sighting" ? !result.record : !result.window)
      throw new AppError("not_found");
    if (
      result.kind === "perception_window" &&
      result.window?.run.scopeEpoch !== input.scope.scope_epoch
    )
      throw new AppError("not_found");
    const response = agentMaterialResponseSchema.parse(result);
    if (jsonBytes(response) > agentContextPolicy.historyResponseBytes)
      throw new HouseholdError("capacity_exceeded");
    return response;
  };
}
