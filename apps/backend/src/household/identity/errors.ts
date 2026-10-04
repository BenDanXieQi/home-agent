/** Registration lifecycle failures; HTTP chooses status codes and translations. */
export class ReferenceEnrollmentError extends Error {
  constructor(
    readonly reason:
      | "busy"
      | "model_unavailable"
      | "enrollment_unavailable"
      | "source_unavailable"
      | "invalid_recording",
  ) {
    super(reason);
    this.name = "ReferenceEnrollmentError";
  }
}
