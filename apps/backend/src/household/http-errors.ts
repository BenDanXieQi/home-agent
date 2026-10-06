import { AppError } from "@home-agent/api/errors";
import type { ErrorCode } from "@home-agent/api/contracts";
import type { HouseholdError } from "./errors";

const codes = {
  stale_session: "household_scope_changed",
  not_bound: "household_unavailable",
  invalid_state: "household_unavailable",
  binding_conflict: "household_scope_changed",
  capacity_exceeded: "household_capacity_exceeded",
  home_storage: "household_storage_unavailable",
  home_unavailable: "household_unavailable",
  spec_unavailable: "household_unavailable",
  device_not_found: "not_found",
  devices_failed: "household_unavailable",
} satisfies Record<HouseholdError["reason"], ErrorCode>;

export function householdHttpError(error: HouseholdError) {
  return new AppError(codes[error.reason]);
}
