import type { HouseholdRuntime } from "./runtime";
import { HouseholdError } from "./errors";

export function accessHousehold(household: HouseholdRuntime, scope: string) {
  const snapshot = household.snapshot();
  const current = snapshot.projection.household.household;
  const assertCurrent = () => {
    const latest = household.snapshot();
    if (latest.scope_epoch !== scope || !household.ready)
      throw new HouseholdError("stale_session");
  };
  assertCurrent();
  if (!current.account_id || !current.home_id)
    throw new HouseholdError("not_bound");
  return {
    snapshot,
    identity: { accountId: current.account_id, homeId: current.home_id },
    assertCurrent,
  };
}
