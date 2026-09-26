/** Failures of household invariants; adapters choose wire codes and messages. */
export class HouseholdError extends Error {
  constructor(
    readonly reason:
      | "stale_session"
      | "not_bound"
      | "invalid_state"
      | "binding_conflict"
      | "capacity_exceeded"
      | "home_storage"
      | "home_unavailable"
      | "spec_unavailable"
      | "device_not_found"
      | "devices_failed",
  ) {
    super(reason);
    this.name = "HouseholdError";
  }
}
