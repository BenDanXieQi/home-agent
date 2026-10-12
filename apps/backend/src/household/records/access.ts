import { AppError } from "@home-agent/api/errors";
import type { Database } from "../../db";
import { mijiaHomeSelections } from "../../db/schema";
import type { HouseholdRuntime } from "../runtime";
import { HouseholdError } from "../errors";

/** Local retained records remain readable when the vendor session is unavailable. */
export function createStoredRecordAccess(
  db: Database,
  household: HouseholdRuntime,
) {
  return async (epoch: string, signal: AbortSignal) => {
    const assertCurrent = () => {
      if (signal.aborted) throw new AppError("request_cancelled");
      if (
        household.epoch !== epoch ||
        household.snapshot().projection.household.household.status ===
          "stopping"
      )
        throw new HouseholdError("stale_session");
    };
    assertCurrent();
    const bindings = await db.select().from(mijiaHomeSelections).limit(2);
    assertCurrent();
    const binding = bindings[0];
    if (bindings.length !== 1 || !binding?.homeId)
      throw new HouseholdError("not_bound");
    // Every repository rechecks this identity under the shared binding lock.
    return {
      identity: { accountId: binding.accountKey, homeId: binding.homeId },
      assertCurrent,
    };
  };
}
