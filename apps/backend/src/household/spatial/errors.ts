export class SpatialError extends Error {
  constructor(
    readonly reason:
      | "scope_changed"
      | "record_changed"
      | "not_found"
      | "record_exists"
      | "reference_invalid"
      | "source_invalid"
      | "storage_unavailable",
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = "SpatialError";
  }
}
