import type { HouseholdRuntime } from "../runtime";
import { HouseholdError } from "../errors";
export function createMemberAccess(household: HouseholdRuntime) {
  return (scope: string) => {
    const current = household.snapshot().projection.household.household;
    const assertCurrent = () => {
      const latest = household.snapshot();
      if (
        latest.scope_epoch !== scope ||
        !household.ready ||
        latest.projection.household.household.account_id !==
          current.account_id ||
        latest.projection.household.household.home_id !== current.home_id
      )
        throw new HouseholdError("stale_session");
    };
    assertCurrent();
    if (!current.account_id || !current.home_id)
      throw new HouseholdError("not_bound");
    return {
      identity: { accountId: current.account_id, homeId: current.home_id },
      assertCurrent,
    };
  };
}
