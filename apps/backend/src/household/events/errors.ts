export class HouseholdEventError extends Error {
  constructor(
    readonly reason:
      | "conflict"
      | "invalid_event"
      | "expired"
      | "future_event"
      | "capacity_exceeded",
  ) {
    super(`Household event: ${reason}`);
    this.name = "HouseholdEventError";
  }
}
