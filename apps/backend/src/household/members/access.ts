import type { HouseholdRuntime } from "../runtime";
import { accessHousehold } from "../access";
export function createMemberAccess(household: HouseholdRuntime) {
  return (scope: string) => accessHousehold(household, scope);
}
