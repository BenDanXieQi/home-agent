export class SpatialError extends Error {
  constructor(
    readonly reason:
      | "record_changed"
      | "not_found"
      | "record_exists"
      | "reference_invalid"
      | "layout_referenced"
      | "source_invalid"
      | "storage_unavailable",
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = "SpatialError";
  }
}
